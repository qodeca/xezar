import test from 'node:test';
import assert from 'node:assert/strict';
import { parse as parseYaml } from 'yaml';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const checks=path.dirname(fileURLToPath(import.meta.url));
const kit=path.dirname(checks);
const repo=path.resolve(kit,'..');
const exec=(cmd,args,cwd=repo)=>execFileSync(cmd,args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const main=path.dirname(exec('git',['rev-parse','--path-format=absolute','--git-common-dir']));
const scratch=path.join(main,'.local/xezar-tests');fs.mkdirSync(scratch,{recursive:true});
const owned=fs.mkdtempSync(path.join(scratch,'dogfood-'));
const git=(cwd,...args)=>exec('git',args,cwd);
const roots=[];
function fixture(){const root=fs.mkdtempSync(path.join(owned,'repo-'));roots.push(root);git(root,'init','-q','-b','main');fs.writeFileSync(path.join(root,'AGENTS.md'),'# fixture\n');fs.writeFileSync(path.join(root,'.gitignore'),'.xezar/\n.local/\nnode_modules/\n');git(root,'add','AGENTS.md','.gitignore');git(root,'-c','user.email=test@example.invalid','-c','user.name=fixture','commit','-qm','fixture');fs.mkdirSync(path.join(root,'.xezar'),{recursive:true});for(const part of ['checks','skills','workflows','docs','config.json','CLAUDE.md'])fs.cpSync(path.join(kit,part),path.join(root,'.xezar',part),{recursive:true});return root;}
function worktree(root,id='ab123456-task'){const wt=path.join(root,'.local/xezar/worktrees',id);git(root,'worktree','add','-qb',`xez/${id.slice(0,8)}`,wt,'main');return wt;}
function bootstrap(root,wt){return spawnSync('bash',[path.join(root,'.xezar/checks/bootstrap.sh')],{cwd:wt,encoding:'utf8',env:{...process.env,XEZ_TASK_ID:''}});}
function fp(wt){return exec('bash',['-c','. .xezar/checks/lib/common.sh; resolve_task_paths; deps_fingerprint'],wt);}
test.after(()=>{for(const root of roots){for(const line of git(root,'worktree','list','--porcelain').split('\n'))if(line.startsWith('worktree ')){const wt=line.slice(9);if(wt!==root){assert.ok(wt.startsWith(root+path.sep));git(root,'worktree','remove','--force',wt);}}}const real=fs.realpathSync(owned);assert.ok(real.startsWith(fs.realpathSync(scratch)+path.sep));assert.notEqual(real,fs.realpathSync(repo));fs.rmSync(owned,{recursive:true});});
test('real Xezar workflow loader and skill parser accept every local role without provider pins',()=>{
 const source=`import {loadWorkflows} from ${JSON.stringify(pathToFileURL(path.join(repo,'packages/xezar/src/workflows/load.ts')).href)};import {parseFrontmatter} from ${JSON.stringify(pathToFileURL(path.join(repo,'packages/xezar/src/skills.ts')).href)};import fs from 'node:fs';const r=await loadWorkflows(${JSON.stringify(repo)});if(r.issues.length)throw Error(JSON.stringify(r.issues));const own=r.workflows.filter(x=>x.source==='file');if(own.length!==14)throw Error('role count');for(const w of own){if(w.steps[0].id!=='kit')throw Error('bootstrap missing');if(w.steps.at(-1).command)throw Error('noninteractive final');for(const step of w.steps){if(step.model||step.runner)throw Error('foreign pin');if(step.skill){const f=${JSON.stringify(path.join(kit,'skills'))}+'/'+step.skill+'.md';const parsed=parseFrontmatter(fs.readFileSync(f,'utf8'));if(!parsed)throw Error('skill parse');}if(step.onFail&&step.onFail.max!==2)throw Error('retry changed');}} console.log(own.length);`;
 assert.equal(exec(process.execPath,['--import','tsx','--input-type=module','-e',source]),'14');
});
test('canonical gates match the five actual validation commands in exact order',()=>{
 const list=JSON.parse(exec('bash',[path.join(checks,'repo-gates.sh'),'--list','--json']));
 const agreed=JSON.parse(fs.readFileSync(path.join(repo,'.ai/agentic.config.json'))).validation.commands;
 assert.deepEqual(list.gates.map(g=>g.command).filter(c=>agreed.includes(c)),agreed);
 assert.equal(list.gates.at(-1).command,'.xezar/checks/repository-checks.sh');
 assert.equal(list.gates[0].command,'npm ci');
 const scripts=JSON.parse(fs.readFileSync(path.join(repo,'package.json'))).scripts;
 for(const c of agreed){const name=c==='npm test'?'test':c.slice('npm run '.length);assert.ok(scripts[name]);}
});
test('bootstraps only the kit into an uncommitted fresh worktree, preserving application/history/secrets',()=>{
 const root=fixture();fs.writeFileSync(path.join(root,'unrelated.txt'),'do not copy');fs.writeFileSync(path.join(root,'.xezar','launch-key'),'fixture-secret');fs.mkdirSync(path.join(root,'.local/xezar/runs'),{recursive:true});fs.writeFileSync(path.join(root,'.local/xezar/runs','fixture'),'do not copy');
 const wt=worktree(root);const head=git(wt,'rev-parse','HEAD');const r=bootstrap(root,wt);assert.equal(r.status,0,r.stderr);assert.ok(fs.existsSync(path.join(wt,'.xezar/checks/repo-gates.sh')));assert.ok(!fs.existsSync(path.join(wt,'unrelated.txt')));assert.ok(!fs.existsSync(path.join(wt,'.local/xezar/launch-key')));assert.ok(!fs.existsSync(path.join(wt,'.local/xezar/runs')));assert.equal(git(wt,'rev-parse','HEAD'),head);assert.equal(git(wt,'status','--porcelain'),'');
 const target=path.join(wt,'.xezar/skills/xezar-testing.md');const old=fs.readFileSync(target,'utf8');fs.appendFileSync(path.join(root,'.xezar/skills/xezar-testing.md'),'new upstream');assert.equal(bootstrap(root,wt).status,0);assert.equal(fs.readFileSync(target,'utf8'),old);
});
test('bootstrap refuses wrong branch, conflicting existing assets and symlink traversal',()=>{
 const root=fixture();const wt=worktree(root);git(wt,'checkout','-qb','wrong');assert.notEqual(bootstrap(root,wt).status,0);git(wt,'checkout','xez/ab123456');
 const local=path.join(wt,'.xezar/skills');fs.mkdirSync(local,{recursive:true});fs.writeFileSync(path.join(local,'xezar-testing.md'),'existing work');assert.notEqual(bootstrap(root,wt).status,0);assert.equal(fs.readFileSync(path.join(local,'xezar-testing.md'),'utf8'),'existing work');fs.rmSync(local,{recursive:true});fs.symlinkSync(path.join(root,'.xezar/skills'),local);assert.notEqual(bootstrap(root,wt).status,0);
});
test('npm fingerprint invalidates on lock/shrinkwrap/root/workspace/npmrc/patch inputs',()=>{
 const root=fixture();const wt=worktree(root);assert.equal(bootstrap(root,wt).status,0);
 for(const file of ['package-lock.json','npm-shrinkwrap.json','package.json','packages/new/package.json','.npmrc','patches/fix.patch']){let before=fp(wt);const p=path.join(wt,file);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,file.endsWith('.json')?'{}':'fixture');assert.notEqual(fp(wt),before,file);before=fp(wt);fs.appendFileSync(p,'\n');assert.notEqual(fp(wt),before,file);}
});
test('optional config discovery and malformed supplied config have distinct outcomes',()=>{
 const root=fixture();const wt=worktree(root);assert.equal(bootstrap(root,wt).status,0);fs.unlinkSync(path.join(wt,'.xezar/config.json'));const run=()=>spawnSync('bash',['-c','. .xezar/checks/lib/common.sh; resolve_task_paths; printf "%s" "$BASE_BRANCH"'],{cwd:wt,encoding:'utf8'});assert.equal(run().stdout,'main');fs.writeFileSync(path.join(wt,'.xezar/config.json'),'{broken');const fail=spawnSync('bash',['-c','. .xezar/checks/lib/common.sh; resolve_task_paths'],{cwd:wt,encoding:'utf8'});assert.notEqual(fail.status,0);
});
test('runtime remains ignored including unknown future state; all maintained roles/docs exist',()=>{
 for(const file of ['.local/xezar/launch-key','.local/xezar/runs/a.json','.local/xezar/worktrees/a/file','.local/xezar-tasks/a/result.json'])assert.equal(spawnSync('git',['check-ignore','-q','--',file],{cwd:repo}).status,0,file);
 assert.equal(fs.readdirSync(path.join(kit,'skills')).filter(x=>x.endsWith('.md')).length,16);
 for(const f of ['README.md','business-analysis.md','close-out.md','enhancement-ideas.md','lessons-learned.md','parallel-tasks.md','recovery.md','single-task-pilot.md','ui-operations.md','upgrade-checklist.md','worktrees.md','dogfooding.md'])assert.ok(fs.existsSync(path.join(kit,'docs',f)));
});
test('SDLC policy never maps unknown labels or failed QA to merge eligibility',async()=>{
 const {projectPolicy}=await import('./lib/project-policy.mjs');
 assert.ok(projectPolicy({}).unavailable);assert.ok(projectPolicy({labels:[{}]}).unavailable);
 for(const label of ['blocked','do-not-merge','qa','qa-failed'])assert.ok(projectPolicy({labels:[{name:label}]}).refused);
 assert.ok(projectPolicy({labels:[{name:'needs-qa'}]}).refused);
 assert.ok(projectPolicy({labels:[{name:'needs-qa'},{name:'skip-qa'}]}).refused);
 assert.equal(projectPolicy({labels:[{name:'needs-qa'},{name:'qa-approved'}]}).passed,true);
 assert.equal(projectPolicy({labels:[]}).passed,true);
 const source=fs.readFileSync(path.join(checks,'integration-preflight.sh'),'utf8');assert.match(source,/lib\/project-policy\.mjs/);assert.match(source,/PROJECT_CHECKS=\("Typecheck, unit tests, build, and package" "Cockpit browser e2e" "Xezar infrastructure fixtures"\)/);assert.match(source,/SKIP_ALLOWED=\(\)/);
});
test('guidance covers semantic analysis, stage ownership, squash policy and evidence tiers',()=>{
 const doc=fs.readFileSync(path.join(kit,'docs/business-analysis.md'),'utf8').toLowerCase();
 for(const field of ['revision','intake','problem','evidence','material assumptions','scope','non-goals','business rules','status quo','alternatives','acceptance criteria','failure paths','unknowns','recommendation','authority'])assert.ok(doc.includes(field),field);
 for(const skill of fs.readdirSync(path.join(kit,'skills'))){const body=fs.readFileSync(path.join(kit,'skills',skill),'utf8');assert.match(body,/at most two/);assert.match(body,/late steering/);assert.match(body,/Never waive mandatory quality/);assert.match(body,/bootstrap\.sh/);}
});
// #156: a peer task's `pkill -f "repo-gates.sh --fast"` killed five agents,
// because every skill body carries that literal and xezar passes the whole
// body to the CLI as `--append-system-prompt`. The ban has to reach an agent
// mid-task, so it lives in the same shared clause block the loop above pins —
// in every skill AND in the kit guide, not in a document nobody opens.
test('guidance bans unscoped pattern kills and names the safe forms',()=>{
 const surfaces=[fs.readFileSync(path.join(kit,'CLAUDE.md'),'utf8'),
  ...fs.readdirSync(path.join(kit,'skills')).map((s)=>fs.readFileSync(path.join(kit,'skills',s),'utf8'))];
 assert.equal(surfaces.length,17);
 for(const body of surfaces){
  assert.match(body,/pkill -f/);            // the trap is named, not implied
  assert.match(body,/--append-system-prompt/); // and so is WHY it reaches peers
  assert.match(body,/pkill -P \$\$/);       // own children
  assert.match(body,/pgrep -fl/);           // inspect before you signal
 }
 // And no kit shell script may itself run one. Comment lines are exempt (the
 // existing SIGKILL notes); this file is not scanned because asserting on the
 // rule means naming the commands it bans.
 const walk=(dir)=>fs.readdirSync(dir,{withFileTypes:true}).flatMap((e)=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);
 const scripts=walk(path.join(kit,'checks')).filter((f)=>f.endsWith('.sh'));
 assert.ok(scripts.length>=10);
 for(const file of scripts)assert.doesNotMatch(fs.readFileSync(file,'utf8'),/^[^#\n]*\b(pkill|killall)\b/m,file);
 const recovery=fs.readFileSync(path.join(kit,'docs/recovery.md'),'utf8');assert.match(recovery,/squash/);assert.match(recovery,/cannot prove the manager lease/);
 const learning=fs.readFileSync(path.join(kit,'docs/dogfooding.md'),'utf8');for(const tier of ['adapted','fixture-tested','real-task verified','recommended'])assert.ok(learning.includes(tier));
});

test('bootstrap explicitly refuses a dangling destination asset symlink',()=>{const root=fixture();const wt=worktree(root);const dir=path.join(wt,'.xezar/skills');fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'xezar-testing.md');fs.symlinkSync(path.join(root,'missing'),file);const result=bootstrap(root,wt);assert.notEqual(result.status,0);assert.match(result.stderr,/symlink refused/);assert.ok(fs.lstatSync(file).isSymbolicLink());});

test('task-local guide changes invalidate the judged kit content even when ignored',()=>{const root=fixture();const wt=worktree(root);assert.equal(bootstrap(root,wt).status,0);const fingerprint=()=>exec('bash',['-c','. .xezar/checks/lib/common.sh; resolve_task_paths; tree_fingerprint'],wt);const before=fingerprint();fs.appendFileSync(path.join(wt,'.xezar/CLAUDE.md'),'\nchanged guidance');assert.notEqual(fingerprint(),before);});

test('bootstrap refuses a checkout under the retired pre-.xezar worktree location',()=>{
 const root=fixture();const id='cd123456-legacy';const wt=path.join(root,'.ai/xezar/worktrees',id);git(root,'worktree','add','-qb',`xez/${id.slice(0,8)}`,wt,'main');
 const result=bootstrap(root,wt);assert.notEqual(result.status,0);
 assert.ok(!fs.existsSync(path.join(wt,'.local/xezar-kit/snapshot.json')));
});

// Self-contained delivered skills deliberately retain the shared text; detect drift at authoring time.
test('shared contracts reject a single skill dropping a guarantee', () => {
 const root=fixture();
 const catalog=path.join(root,'.xezar/checks/catalog-check.mjs');
 assert.equal(spawnSync(process.execPath,[catalog,root],{encoding:'utf8'}).status,0);
 const skill=path.join(root,'.xezar/skills/xezar-testing.md');
 fs.writeFileSync(skill,fs.readFileSync(skill,'utf8').replace('Never waive mandatory quality/AC.','Quality is optional.'));
 const result=spawnSync(process.execPath,[catalog,root],{encoding:'utf8'});
 assert.notEqual(result.status,0);
 assert.match(result.stdout,/shared contract/i);
});


test('infrastructure CI is unconditional and agrees with the required integration check',()=>{
 const ci=parseYaml(fs.readFileSync(path.join(repo,'.github/workflows/ci.yml'),'utf8'));
 const job=ci.jobs['xezar-infra-fixtures'];
 assert.equal(job.name,'Xezar infrastructure fixtures');
 assert.equal(job.if,undefined);assert.equal(job.needs,undefined);assert.equal(job['continue-on-error'],undefined);
 for(const event of ['pull_request','push']){assert.ok(ci.on[event]);assert.equal(ci.on[event].paths,undefined);assert.equal(ci.on[event]['paths-ignore'],undefined);}
 assert.ok(job.steps.some(s=>s.run==='npm ci'));
 assert.ok(job.steps.some(s=>s.run==='bash .xezar/checks/infra-tests.sh'));
 for(const step of job.steps){assert.equal(step.if,undefined);assert.equal(step['continue-on-error'],undefined);}
});
