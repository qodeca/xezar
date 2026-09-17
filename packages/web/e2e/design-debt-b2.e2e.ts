import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AgentBrowser, bootProjectId, fixtureServeEnv, readTestEnv, removeDataRoot, stopFixtureServer, xezarCli } from './agent-browser'

// B2 owns its server and browser; no writes to the shared QA workspace or a real account.
// Fixture replies below exercise UI failure/pending states, not server authorization.
const sessionId = `e2e-b2-${process.pid}`
const artifacts = resolve(import.meta.dirname, '../../../.local/qa/b2-captures')
const densities = ['comfortable', 'roomy', 'compact', 'ultra'] as const
const drawer = '[data-slot="mobile-nav-drawer"]'
const menu = '[data-slot="mobile-top-bar"] button'
let browser: AgentBrowser
let server: ChildProcess
let root: string
let url: string
let project: string
let emulationSocket: WebSocket | undefined

function read<T>(expression: string): T {
  return JSON.parse(browser.evaluate(`JSON.stringify((() => { return (${expression}) })())`) as string) as T
}
function wait(selector: string) {
  browser.waitForFunction(`document.querySelector(${JSON.stringify(selector)}) !== null`)
  browser.waitForFunction(`document.querySelector(${JSON.stringify(selector)}).getAnimations({subtree:true}).every(a => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity)`)
}
function close(selector: string) {
  browser.press('Escape')
  browser.waitForFunction(`document.querySelector(${JSON.stringify(selector)}) === null`)
}
function home(width = 375) {
  browser.setViewport(width, 812)
  browser.goto(`${url}/p/${project}/`)
  wait('[data-slot="app-shell"]')
}
function openDrawer() {
  browser.click(menu); wait(drawer)
  browser.waitForFunction(`document.querySelector('${drawer}').getBoundingClientRect().left === 0`)
}
function density(value: string) {
  // Apply the real appearance setting through the UI so the provider persists it across routes.
  browser.goto(`${url}/settings/global/appearance`)
  wait('[data-slot="appearance-density"]')
  browser.click(`[data-slot="appearance-density"] [data-value="${value}"]`)
  browser.waitForFunction(`(document.documentElement.dataset.density ?? 'comfortable') === '${value}'`)
}

// Actual interactive descendants, including disabled controls and portalled menu/command rows.
// The ToolsMenu slot belongs to B5; its controls are outside this manifest.
// Each target is scrolled into view before checking clipping and intersection. Pseudo-element
// hit regions count only when painted, with non-overlap checked against sibling targets.
type Geometry = { targets: string[]; short: string[]; clipped: string[]; overlaps: string[]; overflow: boolean; chips: number[] }
function geometry(scope: string): Geometry {
  return read(`(() => {
    const parent = document.querySelector(${JSON.stringify(scope)});
    if (!parent) throw new Error('Missing measured surface: ' + ${JSON.stringify(scope)});
    const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
    const nodes = [...parent.querySelectorAll('a[href],button,input,[role="menuitem"],[role="option"]')].filter(visible).filter(el => !el.closest('[data-slot="tools-menu"]'));
    if (!nodes.length) throw new Error('No interactive targets in measured surface');
    const name = el => el.dataset.slot || el.getAttribute('aria-label') || el.textContent.trim().slice(0,60);
    const box = el => {
      const b = el.getBoundingClientRect(), s = getComputedStyle(el, '::before');
      const w = s.content !== 'none' && s.display !== 'none' ? parseFloat(s.width) : 0;
      const h = s.content !== 'none' && s.display !== 'none' ? parseFloat(s.height) : 0;
      return { x: b.x - Math.max(0,w-b.width)/2, y: b.y - Math.max(0,h-b.height)/2, w: Math.max(b.width,w||0), h: Math.max(b.height,h||0) };
    };
    const short=[], clipped=[], overlaps=[];
    for (const el of nodes) {
      el.scrollIntoView({block:'center', inline:'nearest', behavior:'instant'});
      const b=box(el);
      if (b.w < 43.5 || b.h < 43.5) short.push(name(el)+': '+b.w+' x '+b.h);
      if (b.x < -0.5 || b.x+b.w > innerWidth+0.5 || b.y < -0.5 || b.y+b.h > innerHeight+0.5) clipped.push(name(el));
      for (const other of nodes) {
        if (el === other || el.contains(other) || other.contains(el)) continue;
        const a=box(other);
        if (Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)>0.5 && Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y)>0.5) overlaps.push(name(el)+' / '+name(other));
      }
    }
    const chips=[...parent.querySelectorAll('[data-slot="badge"],[data-slot="nav-badge"],[data-slot="nav-unread-badge"],[data-slot="project-attention"],[data-slot="project-missing"],[data-slot="version-chip"]')].filter(visible).map(el=>el.getBoundingClientRect().height);
    return { targets:nodes.map(name), short, clipped, overlaps, chips, overflow:document.documentElement.scrollWidth>innerWidth };
  })()`)
}
function assertGeometry(scope: string) {
  const g = geometry(scope)
  expect(g.targets.length).toBeGreaterThan(0)
  expect(g.short, `${scope}: below 44px`).toEqual([])
  expect(g.clipped, `${scope}: clipped target`).toEqual([])
  expect(g.overlaps, `${scope}: overlapping targets`).toEqual([])
  expect(g.overflow, `${scope}: horizontal overflow`).toBe(false)
  expect(g.chips.filter(h => h < 23.5), 'chip floor 24px').toEqual([])
}

function fixtureReplies(mode = 'ready') {
  read(`(() => {
    window.__b2Mode=${JSON.stringify(mode)};
    if (window.__b2Fetch) return true;
    window.__b2Fetch=window.fetch.bind(window);
    window.fetch=async (input, init) => {
      const target=String(input instanceof Request ? input.url : input);
      const answer=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
      if(target.includes('/fs/browse')) {
        if(window.__b2Mode==='loading') await new Promise(resolve=>window.__b2Release=resolve);
        if(window.__b2Mode==='error') return answer({error:'Folder access refused'},403);
        return answer({path:'/fixture/long-parent-folder',parent:'/fixture',truncated:true,dirs:window.__b2Mode==='empty'?[]:[
          {name:'A very long project folder name that must never push its Open button out',path:'/fixture/long-parent-folder/child',isRepo:true}
        ]});
      }
      if(target.endsWith('/projects/checkout')) {
        if(window.__b2Mode==='pending') await new Promise(resolve=>window.__b2CheckoutRelease=resolve);
        return answer({error:'Clone refused for this fixture'},409);
      }
      if(target.endsWith('/projects') && init?.method==='POST') return answer({error:'Project registration refused'},409);
      return window.__b2Fetch(input,init);
    };
    return true;
  })()`)
}
function addMenu() {
  browser.click(`${drawer} button[aria-label="Add project"]`)
  wait('[data-slot="dropdown-menu-content"]')
}
function openLocal() {
  addMenu(); browser.click('[data-slot="add-project-local"]'); wait('[data-slot="add-project-dialog"]')
}
function openClone() {
  addMenu(); browser.click('[data-slot="add-project-clone"]'); wait('[data-slot="clone-project-dialog"]')
}

beforeAll(async () => {
  // test-local-state supplies a per-checkout scratch outside the registry-excluded worktree path.
  root=mkdtempSync(join(tmpdir(),'xezar-e2e-b2-'))
  mkdirSync(join(root,'.xez-home'),{recursive:true})
  const now='2026-09-16T00:00:00.000Z'
  writeFileSync(join(root,'.xez-home/config.json'),JSON.stringify({projects:[
    {id:'b2-project',name:'A long registered project name for shell geometry',root,addedAt:now,lastOpenedAt:now,source:'local'},
    {id:'b2-missing',name:'Missing project with a long label',root:join(root,'gone'),addedAt:now,lastOpenedAt:now,source:'local'},
  ]}))
  const port=await new Promise<number>((done,fail)=>{const s=createServer();s.once('error',fail);s.listen(0,'127.0.0.1',()=>{const a=s.address();const n=typeof a==='object'&&a?a.port:0;s.close(()=>done(n))})})
  url=`http://localhost:${port}`
  server=spawn(process.execPath,[xezarCli,'serve','--repo',root,'--port',String(port),'--no-open'],{env:fixtureServeEnv(root),stdio:'ignore'})
  let healthy=false
  for(let n=0;n<60;n++){try{if((await fetch(`${url}/api/v1/health`)).ok){healthy=true;break}}catch{} await new Promise(r=>setTimeout(r,250))}
  if(!healthy)throw new Error('B2 fixture server did not start')
  project=await bootProjectId(url)
  browser=AgentBrowser.open(sessionId)
  browser.goto(url)
  // Attach only to this provider session's active page. Device presets do not enable touch;
  // keep this CDP session alive so Chromium retains its real input/media emulation.
  const cli=(...args:string[])=>{
    const result=JSON.parse(execFileSync(readTestEnv().browser.command,
      ['--session',sessionId,...args,'--json'],{encoding:'utf8',timeout:60_000}))
    if(!result.success)throw new Error('B2 provider command failed')
    return result.data
  }
  const socket=new WebSocket(cli('get','cdp-url').cdpUrl)
  emulationSocket=socket
  await new Promise<void>((done,fail)=>{
    const timeout=setTimeout(()=>fail(new Error('B2 emulation connection timed out')),5_000)
    socket.onopen=()=>{clearTimeout(timeout);done()};socket.onerror=()=>{clearTimeout(timeout);fail(new Error('B2 emulation connection failed'))}
  })
  let nextId=0
  const pending=new Map<number,{resolve:(value:any)=>void;reject:(reason:Error)=>void}>()
  socket.onmessage=event=>{
    const message=JSON.parse(String(event.data)),request=pending.get(message.id)
    if(!request)return
    pending.delete(message.id)
    if(message.error)request.reject(new Error(JSON.stringify(message.error)));else request.resolve(message.result)
  }
  const send=(method:string,params:object,session?:string)=>new Promise<any>((done,fail)=>{
    const id=++nextId,timeout=setTimeout(()=>{pending.delete(id);fail(new Error('B2 emulation command timed out'))},5_000)
    pending.set(id,{resolve:value=>{clearTimeout(timeout);done(value)},reject:error=>{clearTimeout(timeout);fail(error)}})
    socket.send(JSON.stringify({id,method,params,...(session?{sessionId:session}:{})}))
  })
  const tab=cli('tab','list').tabs.find((tab:{active:boolean})=>tab.active)
  if(!tab)throw new Error('B2 provider has no active page')
  const attached=await send('Target.attachToTarget',{targetId:tab.targetId,flatten:true})
  await send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1},attached.sessionId)
  await send('Emulation.setEmulatedMedia',{features:[{name:'hover',value:'none'},{name:'pointer',value:'coarse'}]},attached.sessionId)
  browser.setViewport(375,812)
  mkdirSync(artifacts,{recursive:true})
},60_000)
afterAll(async()=>{emulationSocket?.close();browser?.close();await stopFixtureServer(server);if(root)await removeDataRoot(root)})

describe('B2 phone matrix',()=>{
  it.each(densities)('T-2/T-0 every shell, palette, folder and clone target at %s',densityValue=>{
    density(densityValue);home();fixtureReplies()
    expect(read(`innerWidth`)).toBe(375)
    expect(read(`matchMedia('(hover: none)').matches`)).toBe(true)
    assertGeometry('[data-slot="mobile-top-bar"]')
    openDrawer(); assertGeometry(drawer)
    expect(browser.text(`${drawer} [data-slot="project-missing"]`)).toBe('folder not found')
    addMenu();assertGeometry('[data-slot="dropdown-menu-content"]');close('[data-slot="dropdown-menu-content"]')
    openLocal();wait('[data-slot="fs-dir"]');assertGeometry('[data-slot="add-project-dialog"]')
    browser.click('[data-slot="fs-dir"]');browser.click('[data-slot="add-project-confirm"]');wait('[data-slot="add-project-error"]')
    expect(browser.text('[data-slot="add-project-error"]')).toBe('Project registration refused')
    assertGeometry('[data-slot="add-project-dialog"]');close('[data-slot="add-project-dialog"]')
    browser.waitForFunction(`document.activeElement?.getAttribute('aria-label')==='Add project'`)
    read(`(() => {window.__b2Mode='pending';return true})()`)
    openClone();assertGeometry('[data-slot="clone-project-dialog"]') // includes disabled Clone
    browser.fill('[data-slot="clone-url"]','example/project');browser.press('Enter');wait('[data-slot="clone-progress"]')
    assertGeometry('[data-slot="clone-project-dialog"]')
    browser.press('Escape')
    expect(read(`document.querySelector('[data-slot="clone-project-dialog"]')!==null`)).toBe(true)
    read(`(() => {window.__b2CheckoutRelease();return true})()`)
    wait('[data-slot="clone-error"]')
    expect(browser.text('[data-slot="clone-error"]')).toBe('Clone refused for this fixture')
    assertGeometry('[data-slot="clone-project-dialog"]');close('[data-slot="clone-project-dialog"]')
    close(drawer)
    browser.press('Control+k');wait('[data-slot="dialog-content"]:has([cmdk-root])');wait('[data-slot="palette-project"]')
    assertGeometry('[data-slot="dialog-content"]:has([cmdk-root])')
    expect(browser.text('[data-slot="dialog-content"]:has([cmdk-root]) [data-slot="project-missing"]')).toBe('folder not found')
    close('[data-slot="dialog-content"]:has([cmdk-root])')
    // Keep the flat shell in the same density matrix, without changing another test's registry.
    const configPath=join(root,'.xez-home/config.json'), saved=readFileSync(configPath,'utf8')
    try {
      const config=JSON.parse(saved);config.projects=config.projects.filter((p:{id:string})=>p.id===project)
      writeFileSync(configPath,JSON.stringify(config))
      home();openDrawer();browser.waitForFunction(`document.querySelector('${drawer} nav[aria-label="Main"]')!==null`)
      assertGeometry(drawer)
      browser.click(`${drawer} a[href$="/new"]`)
      browser.waitForFunction(`location.pathname.endsWith('/new') && document.querySelector('${drawer}')===null`)
    } finally {writeFileSync(configPath,saved)}
  },240_000)
})

it('T-2/T-0 keyboard opens, traps and returns palette focus on phone and desktop',()=>{
  for(const width of [375,1280]){
    home(width)
    // #546: no sidebar launcher any more — the palette opens from the keyboard wherever focus is,
    // so the desktop trigger is an ordinary sidebar link focus must come back to (this fixture is
    // multi-project, so the All tasks link rather than a flat nav row).
    const trigger=width===375?menu:'aside a[href="/tasks"]'
    read(`(() => {document.querySelector('${trigger}').focus();return true})()`)
    browser.press('Control+k');wait('[data-slot="dialog-content"]:has([cmdk-root])')
    expect(read(`document.activeElement?.hasAttribute('cmdk-input')`)).toBe(true)
    browser.press('Tab');browser.press('Shift+Tab')
    expect(read(`document.querySelector('[data-slot="dialog-content"]:has([cmdk-root])').contains(document.activeElement)`)).toBe(true)
    close('[data-slot="dialog-content"]:has([cmdk-root])')
    expect(read(`document.activeElement===document.querySelector('${trigger}')`)).toBe(true)
    browser.press('Control+k');wait('[data-slot="dialog-content"]:has([cmdk-root])');browser.fill('[cmdk-input]','new task');browser.press('Enter')
    browser.waitForFunction(`location.pathname.endsWith('/new')`)
  }
},120_000)

it('T-0 folder loading, empty and refused states remain distinct in the browser',()=>{
  home();fixtureReplies('loading');openDrawer();openLocal()
  expect(browser.text('[data-slot="fs-breadcrumb"]')).toBe('Loading…')
  expect(read(`document.querySelector('[data-slot="add-project-confirm"]').disabled`)).toBe(true)
  read(`(() => {window.__b2Mode='empty';window.__b2Release();return true})()`)
  browser.waitForFunction(`document.querySelector('[data-slot="fs-listing"]')?.textContent.includes('No subfolders')`)
  read(`(() => {window.__b2Mode='error';return true})()`)
  browser.click('[data-slot="fs-up"]');wait('[data-slot="fs-error"]')
  expect(browser.text('[data-slot="fs-error"]')).toBe('Folder access refused')
  expect(read(`document.querySelector('[data-slot="fs-listing"]')===null`)).toBe(true)
  close('[data-slot="add-project-dialog"]');close(drawer)
},120_000)

it('drawer and project disclosures work with Enter, Space and Escape; stored width and collapse restore',()=>{
  home();read(`(() => {document.querySelector('${menu}').focus();return true})()`);browser.press('Enter');wait(drawer)
  const header=`${drawer} [data-project="${project}"] button[data-slot="project-group-header"]`
  read(`(() => {document.querySelector('${header}').focus();return true})()`)
  const before=read(`document.querySelector('${header}').getAttribute('aria-expanded')`)
  browser.press('Space');expect(read(`document.querySelector('${header}').getAttribute('aria-expanded')`)).not.toBe(before)
  close(drawer);home();openDrawer();expect(read(`document.querySelector('${header}').getAttribute('aria-expanded')`)).not.toBe(before)
  close(drawer);home(1280)
  read(`(() => {document.querySelector('[data-slot="sidebar-resize-handle"]').focus();return true})()`)
  browser.press('ArrowRight')
  const width=read(`document.querySelector('[data-slot="sidebar"]').getBoundingClientRect().width`)
  home(1280);expect(read(`document.querySelector('[data-slot="sidebar"]').getBoundingClientRect().width`)).toBe(width)
},120_000)

it('T-0 effective reduced motion stops hero animation without losing content',()=>{
  for(const reduce of [false,true]){
    browser.setMedia('light',{reducedMotion:reduce});home(1280)
    browser.goto(`${url}/p/${project}/new`);browser.waitForFunction(`document.querySelector('[data-slot="ghost-code-backdrop"]') !== null`)
    const motion=read<string[]>(`[...document.querySelectorAll('[data-slot="twinkle-backdrop"] span, .ghost-code-line')].filter(el=>el.getClientRects().length).map(el=>getComputedStyle(el).animationName)`)
    expect(motion.length).toBeGreaterThan(0)
    if(reduce)expect(motion.filter(name=>name!=='none')).toEqual([])
    else expect(motion.some(name=>name!=='none')).toBe(true)
  }
  browser.setMedia('light')
},120_000)

it.each(['light','dark','system'])('appearance %s with lime/violet preserves shell and dialog layout',theme=>{
  home()
  for(const accent of ['lime','violet']){
    browser.goto(`${url}/settings/global/appearance`);wait('[data-slot="appearance-accent"]')
    browser.click(`[data-slot="appearance-accent"] [data-value="${accent}"]`)
    browser.waitForFunction(`(document.documentElement.dataset.accent ?? 'lime') === '${accent}'`)
    read(`(() => {localStorage.setItem('xez-theme','${theme}');return true})()`)
    browser.setMedia(theme==='system'?'dark':theme as 'light'|'dark')
    home();fixtureReplies();openDrawer();assertGeometry(drawer)
    expect(read(`document.documentElement.dataset.accent ?? 'lime'`)).toBe(accent)
    expect(read(`document.documentElement.classList.contains('light')`)).toBe(theme==='light')
    openLocal();wait('[data-slot="fs-dir"]');assertGeometry('[data-slot="add-project-dialog"]');close('[data-slot="add-project-dialog"]');close(drawer)
  }
  browser.setMedia('light')
},180_000)


it('project dialogs trap keyboard focus and return it to Add project', () => {
  home();fixtureReplies();openDrawer()
  for (const kind of ['local','clone']) {
    if(kind==='local')openLocal();else openClone()
    const selector=kind==='local'?'[data-slot="add-project-dialog"]':'[data-slot="clone-project-dialog"]'
    expect(read(`document.querySelector('${selector}').contains(document.activeElement)`)).toBe(true)
    for(const key of ['Tab','Tab','Tab','Tab','Tab','Tab','Shift+Tab','Shift+Tab']){
      browser.press(key)
      expect(read(`document.querySelector('${selector}').contains(document.activeElement)`)).toBe(true)
    }
    read(`(() => {document.querySelector('${selector} [data-slot="dialog-close"]').focus();return true})()`)
    browser.press('Enter')
    browser.waitForFunction(`document.querySelector('${selector}')===null`)
    browser.waitForFunction(`document.activeElement?.getAttribute('aria-label')==='Add project'`)
    expect(read(`document.activeElement?.getAttribute('aria-label')`)).toBe('Add project')
  }
  close(drawer)
},120_000)

// Convert computed CSS colours through Canvas, so oklch/sRGB and alpha use the browser's own
// colour parser. Composite all ancestor backgrounds; exempt genuinely disabled controls only.
function contrast(scope: string) {
  return read<{name:string;ratio:number}[]>(`(() => {
    const surface=document.querySelector(${JSON.stringify(scope)});
    if(!surface)throw new Error('No contrast surface');
    const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    const rgba=value=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=value;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].map((x,i)=>i===3?x/255:x)};
    const over=(fg,bg)=>fg.slice(0,3).map((v,i)=>v*fg[3]+bg[i]*(1-fg[3]));
    const lum=c=>c.map(v=>v/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);
    return [...surface.querySelectorAll('*')].filter(el=>el.getClientRects().length && [...el.childNodes].some(n=>n.nodeType===3 && n.textContent.trim()) && !el.closest('[aria-hidden="true"], [disabled], [data-disabled="true"], [data-slot="tools-menu"]')).map(el=>{
      const chain=[];for(let p=el;p;p=p.parentElement)chain.unshift(p);
      let bg=[255,255,255];for(const node of chain)bg=over(rgba(getComputedStyle(node).backgroundColor),bg);
      const fg=over(rgba(getComputedStyle(el).color),bg),a=lum(fg),b=lum(bg);
      return {name:el.textContent.trim().slice(0,80),ratio:(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)};
    });
  })()`)
}

it.each(['light','dark'])('small shell/dialog text has composited contrast in %s with both accents',theme=>{
  for(const accent of ['lime','violet']){
    home();browser.goto(`${url}/settings/global/appearance`);wait('[data-slot="appearance-accent"]')
    browser.click(`[data-slot="appearance-accent"] [data-value="${accent}"]`)
    read(`(() => {localStorage.setItem('xez-theme','${theme}');return true})()`)
    home();fixtureReplies();openDrawer()
    const samples=contrast(drawer)
    browser.screenshot(join(artifacts,`${theme}-${accent}-drawer.png`),{viewport:true})
    openLocal();wait('[data-slot="fs-dir"]');samples.push(...contrast('[data-slot="add-project-dialog"]'))
    browser.screenshot(join(artifacts,`${theme}-${accent}-folder.png`),{viewport:true})
    browser.click('[data-slot="add-project-confirm"]');wait('[data-slot="add-project-error"]')
    samples.push(...contrast('[data-slot="add-project-dialog"]'))
    read(`(() => {window.__b2Mode='error';return true})()`);browser.click('[data-slot="fs-up"]');wait('[data-slot="fs-error"]')
    samples.push(...contrast('[data-slot="add-project-dialog"]'))
    close('[data-slot="add-project-dialog"]');openClone();samples.push(...contrast('[data-slot="clone-project-dialog"]'))
    browser.fill('[data-slot="clone-url"]','example/project');browser.press('Enter');wait('[data-slot="clone-error"]')
    samples.push(...contrast('[data-slot="clone-project-dialog"]'))
    close('[data-slot="clone-project-dialog"]');close(drawer)
    expect(samples.length).toBeGreaterThan(0)
    expect(samples.filter(s=>s.ratio<4.5),`${theme}/${accent} small text below 4.5:1`).toEqual([])
  }
},180_000)
