import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, cpSync, readdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const checks = dirname(fileURLToPath(import.meta.url));
const root = resolve(checks, '../../.local/xezar-tests');
mkdirSync(root, {recursive:true});
const scheduler = join(checks, 'lib/gate-parallel.mjs');
const library = join(checks, 'lib/gate-record.sh');
const results = join(checks, 'lib/gate-results.mjs');
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
const command = (source) => `${quote(process.execPath)} -e ${quote(source)}`;
const dirs = [];
test.after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function fixture(failed = false) {
  const dir = mkdtempSync(join(root, 'gate-test-')); dirs.push(dir);
  mkdirSync(join(dir, 'barriers'));
  const entries = [2,3,4,5,6].map(index => ({index,name:`gate ${index}`,command:command(`
    const fs=require('node:fs'), p=${JSON.stringify(join(dir,'barriers'))};
    fs.writeFileSync(p+'/${index}.start','');
    const wait=async(name)=>{const end=Date.now()+5000;while(!fs.existsSync(p+'/'+name)){if(Date.now()>end)throw Error('barrier '+name);await new Promise(r=>setTimeout(r,10));}};
    (async()=>{
      if(${index}===2){await wait('3.start');await wait('4.start');}
      if(${index}===5 && !fs.existsSync(p+'/2.end'))throw Error('build before typecheck');
      if(${index}===6 && !fs.existsSync(p+'/5.end'))throw Error('package before build');
      fs.writeFileSync(p+'/${index}.end','');
      process.exitCode=${failed && index===2 ? 9 : 0};
    })().catch(e=>{console.error(e);process.exitCode=1});
  `)}));
  const begin=spawnSync(process.execPath,[results,'begin','--dir',dir,'--json',JSON.stringify({attemptId:'fixture',required:entries.map(e=>e.name)})],{encoding:'utf8'});
  assert.equal(begin.status,0,begin.stderr);
  const env={...process.env,GATE_ATTEMPT_DIR:dir,GATE_LOG_DIR:join(dir,'logs'),GATE_ATTEMPT_ID:'fixture',GATE_RESULTS_MJS:results};
  return {dir,entries,env};
}
function execute(f) {
 const r=spawnSync(process.execPath,[scheduler,library,'application',JSON.stringify(f.entries)],{env:f.env,encoding:'utf8',timeout:15000});
 assert.equal(r.status,0,r.stderr);
}
function collect(f) {
 const args=f.entries.flatMap(e=>[String(e.index),e.name,e.command]);
 return spawnSync('bash',['-c','. "$1"; shift; failed=0; while [ "$#" -gt 0 ]; do gate_collect_worker "$1" "$2" "$3" || failed=1; shift 3; done; [ "$failed" = 0 ] || exit 1; node "$GATE_RESULTS_MJS" complete --dir "$GATE_ATTEMPT_DIR" --json "{}"','collect',library,...args],{env:f.env,encoding:'utf8'});
}
test('unit lanes overlap while build/package retain dependencies; reduction preserves canonical order',()=>{
 const f=fixture(); execute(f); const r=collect(f);assert.equal(r.status,0,r.stderr);
 const record=JSON.parse(readFileSync(join(f.dir,'result.json')));
 assert.equal(record.result,'passed');assert.deepEqual(record.commands.map(c=>c.name),f.entries.map(e=>e.name));
 assert.equal(new Set(record.commands.map(c=>c.log)).size,5);
});
test('failed typecheck retains later build/package evidence and cannot certify',()=>{
 const f=fixture(true);execute(f);const r=collect(f);assert.equal(r.status,0,r.stderr);
 const record=JSON.parse(readFileSync(join(f.dir,'result.json')));
 assert.equal(record.result,'failed');assert.equal(record.commands.length,5);
 assert.ok(existsSync(join(f.dir,'barriers/6.end')));
});
for(const corruption of ['missing','malformed','identity','command']) test(`worker ${corruption} leaves the aggregate incomplete`,()=>{
 const f=fixture();execute(f);const file=join(f.dir,'workers/6.json');
 if(corruption==='missing')rmSync(file);
 if(corruption==='malformed')writeFileSync(file,'{');
 if(corruption==='identity'){const e=JSON.parse(readFileSync(file));e.name='gate 2';writeFileSync(file,JSON.stringify(e));}
 if(corruption==='command'){const e=JSON.parse(readFileSync(file));e.command='true';writeFileSync(file,JSON.stringify(e));}
 assert.notEqual(collect(f).status,0);assert.equal(existsSync(join(f.dir,'result.json')),false);
});

test('a published pass cannot conceal a nonzero worker exit', () => {
 const f=fixture();
 const wrapper=join(f.dir,'exit-mismatch.sh');
 writeFileSync(wrapper,`. ${quote(library)}\neval "$(declare -f gate_run | sed '1s/gate_run/original_gate_run/')"\ngate_run() { original_gate_run "$@"; return 19; }\n`);
 const r=spawnSync(process.execPath,[scheduler,wrapper,'application',JSON.stringify(f.entries)],{env:f.env,encoding:'utf8',timeout:15000});
 assert.notEqual(r.status,0);
 assert.equal(JSON.parse(readFileSync(join(f.dir,'workers/2.json'))).status,'passed');
 assert.equal(existsSync(join(f.dir,'result.json')),false);
});

test('positional worker arguments preserve spaces, quotes and literal shell syntax', () => {
 const f=fixture();
 const value='spaces "quotes" $(never_execute) `never_execute`';
 const target=join(f.dir,'a file with spaces');
 const entry={index:1,name:'quoted command',command:command(`require('node:fs').writeFileSync(${JSON.stringify(target)},${JSON.stringify(value)})`)};
 const r=spawnSync(process.execPath,[scheduler,library,'serial',JSON.stringify([entry])],{env:f.env,encoding:'utf8',timeout:15000});
 assert.equal(r.status,0,r.stderr);assert.equal(readFileSync(target,'utf8'),value);
});

test('failed parent summary output cannot complete the attempt', () => {
 const f=fixture();execute(f);
 // Close stdout: portable write failure, without depending on Linux /dev/full.
 const r=spawnSync('bash',['-c','. "$1"; exec 1>&-; gate_collect_worker 2 "$2" "$3" || exit 1; node "$GATE_RESULTS_MJS" complete --dir "$GATE_ATTEMPT_DIR" --json "{}"','summary',library,f.entries[0].name,f.entries[0].command],{env:f.env,encoding:'utf8'});
 assert.notEqual(r.status,0);assert.equal(existsSync(join(f.dir,'result.json')),false);
});

async function until(predicate) {
 const end=Date.now()+10000;
 while(!predicate()){if(Date.now()>end)throw Error('condition timed out');await new Promise(r=>setTimeout(r,20));}
}
function alive(pid){try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}}
function outerFixture(body) {
 const dir=mkdtempSync(join(root,'gate-outer-'));dirs.push(dir);
 const target=join(dir,'.xezar/checks');cpSync(checks,target,{recursive:true});
 const git=(...args)=>{const r=spawnSync('git',args,{cwd:dir,encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
 git('init','-q','-b','main');writeFileSync(join(dir,'.gitignore'),'.local/\n');
 git('add','.gitignore');git('-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');
 // Replace only path/environment discovery. Execution, recording and supervision are real.
 writeFileSync(join(target,'lib/common.sh'),`
 resolve_task_paths() { TASK_CWD="$PWD"; TASK_ID=fixture; TASK_ID_SOURCE=fixture; HEAD_SHA=$(git rev-parse HEAD); IS_WORKTREE=0; BRANCH=main; BASE_BRANCH=main; }
 deps_are_fresh() { return 0; }
 deps_resolve_in_task() { [ ! -f "$PWD/borrowed" ] || { echo "fixture: workspace packages borrowed" >&2; return 1; }; }
 task_gates_dir() { printf '%s/gates' "$PWD"; }
 task_manifest_path() { printf '%s/no-manifest' "$PWD"; }
 head_tree_sha() { git rev-parse 'HEAD^{tree}'; }
 tree_fingerprint() { printf fixture; }
 deps_fingerprint() { printf fixture; }
 repo_identity() { printf '{}'; }
 env_profile() { printf '{}'; }
 write_deps_stamp() { touch "$PWD/install-stamp"; }
 `);
 mkdirSync(join(dir,'bin'));writeFileSync(join(dir,'bin/package.json'),'{"type":"commonjs"}');
 writeFileSync(join(dir,'bin/npm'),`#!/usr/bin/env node\n${body}`,{mode:0o755});
 writeFileSync(join(target,'repository-checks.sh'),'#!/usr/bin/env bash\ntouch infra-ran\n',{mode:0o755});
 return {dir,target,env:{...process.env,PATH:join(dir,'bin')+':'+process.env.PATH}};
}
function attemptFiles(dir){const list=[];for(const e of (existsSync(dir)?[...readdirSync(dir,{withFileTypes:true})]:[])) {const p=join(dir,e.name);if(e.isDirectory())list.push(...attemptFiles(p));else list.push(p);}return list;}

test('TERM to the outer runner reaps owned TERM-ignoring descendants and leaves no result', async () => {
 const f=outerFixture(`
 const fs=require('node:fs'),{spawn}=require('node:child_process');
 const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});require('node:fs').writeFileSync('child-'+process.pid,String(process.pid));setInterval(()=>{},1000)"],{stdio:'ignore'});
 process.on('SIGTERM',()=>{});setInterval(()=>{},1000);
 `);
 const outer=spawn('bash',[join(f.target,'repo-gates.sh'),'--fast'],{cwd:f.dir,env:f.env,stdio:['ignore','pipe','pipe']});
 let output='';outer.stdout.on('data',chunk=>output+=chunk);outer.stderr.on('data',chunk=>output+=chunk);
 const ended=new Promise(resolve=>outer.on('exit',(code,signal)=>resolve({code,signal})));
 let pids=[];
 try {
  try {await until(()=>readdirSync(f.dir).filter(n=>n.startsWith('child-')).length===3);} catch(e){throw Error(e.message+'\n'+output);}
  pids=readdirSync(f.dir).filter(n=>n.startsWith('child-')).map(n=>Number(readFileSync(join(f.dir,n),'utf8')));
  outer.kill('SIGTERM');
  const outcome=await Promise.race([ended,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('outer cleanup timed out')),10000);timer.unref();})]);
  assert.notEqual(outcome.code,0);
  await until(()=>pids.every(pid=>!alive(pid)));
  assert.equal(existsSync(join(f.dir,'infra-ran')),false);
  assert.equal(attemptFiles(join(f.dir,'gates')).some(p=>p.endsWith('/result.json')),false);
 } finally {outer.kill('SIGTERM');for(const pid of pids)if(alive(pid))process.kill(pid,'SIGKILL');}
});

test('a worker exiting first cannot leave its TERM-ignoring grandchild alive', async () => {
 const f=fixture();
 const pidFile=join(f.dir,'orphan-pid');
 const childCode=`process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
 const entry={index:1,name:'orphan control',command:command(`const {spawn}=require('node:child_process'),fs=require('node:fs');const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});child.unref();const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(pidFile)})){clearInterval(t);}},10);`)};
 const r=spawnSync(process.execPath,[scheduler,library,'serial',JSON.stringify([entry])],{env:f.env,encoding:'utf8',timeout:15000});
 const pid=Number(readFileSync(pidFile,'utf8'));
 try{assert.equal(r.status,0,r.stderr);await until(()=>!alive(pid));}finally{if(alive(pid))process.kill(pid,'SIGKILL');}
});


test('cancellation racing completed finalization reports the retained completed record', async () => {
 const f=outerFixture('process.exit(0);');
 const record=join(f.target,'lib/gate-record.sh');
 writeFileSync(record,readFileSync(record,'utf8')+`
 eval "$(declare -f gate_attempt_complete | sed '1s/gate_attempt_complete/original_complete/')"
 gate_attempt_complete() { touch "$TASK_CWD/finalizing"; sleep 1; original_complete; }
 `);
 const outer=spawn('bash',[join(f.target,'repo-gates.sh'),'--fast'],{cwd:f.dir,env:f.env,stdio:['ignore','pipe','pipe']});
 let output='';outer.stdout.on('data',c=>output+=c);outer.stderr.on('data',c=>output+=c);
 const ended=new Promise(resolve=>outer.on('exit',code=>resolve(code)));
 try {
  await until(()=>existsSync(join(f.dir,'finalizing')));
  outer.kill('SIGTERM');assert.equal(await ended,130);
  const file=attemptFiles(join(f.dir,'gates')).find(p=>p.endsWith('/result.json'));
  assert.ok(file,output);assert.equal(JSON.parse(readFileSync(file)).result,'passed');
  assert.match(output,/finalization produced a completed record/);
  assert.doesNotMatch(output,/retained attempt is incomplete/);
 } finally {outer.kill('SIGTERM');}
});


// #286: a task worktree sits inside the primary checkout, so a workspace link the install did not
// write resolves from the PRIMARY's node_modules and every later gate judges the primary's source.
const npmLogger = `require('node:fs').appendFileSync(process.cwd()+'/npm-calls',process.argv.slice(2).join(' ')+'\\n');`;
test('an install leaving workspace packages borrowed from another checkout aborts before any gate', () => {
 const f=outerFixture(npmLogger);
 writeFileSync(join(f.dir,'borrowed'),'');
 const r=spawnSync('bash',[join(f.target,'repo-gates.sh')],{cwd:f.dir,env:f.env,encoding:'utf8',timeout:30000});
 assert.notEqual(r.status,0,r.stdout+r.stderr);
 assert.match(r.stderr,/GATES ABORTED: workspace packages resolve outside this task/);
 const calls=readFileSync(join(f.dir,'npm-calls'),'utf8').trim().split('\n');
 assert.ok(calls.includes('ci'),calls.join('|'));
 assert.equal(calls.some(c=>c.startsWith('run')),false,calls.join('|'));
 assert.equal(existsSync(join(f.dir,'install-stamp')),false);
 assert.equal(existsSync(join(f.dir,'infra-ran')),false);
 assert.equal(attemptFiles(join(f.dir,'gates')).some(p=>p.endsWith('/result.json')),false);
});

test('control: an install whose workspace packages resolve inside the task runs every gate and stamps', () => {
 const f=outerFixture(npmLogger);
 const r=spawnSync('bash',[join(f.target,'repo-gates.sh')],{cwd:f.dir,env:f.env,encoding:'utf8',timeout:30000});
 assert.equal(r.status,0,r.stdout+r.stderr);
 assert.ok(existsSync(join(f.dir,'install-stamp')));
 assert.ok(existsSync(join(f.dir,'infra-ran')));
 const file=attemptFiles(join(f.dir,'gates')).find(p=>p.endsWith('/result.json'));
 assert.ok(file);assert.equal(JSON.parse(readFileSync(file)).result,'passed');
});

test('ordinary build failure still runs package and records aggregate failure',()=>{
 const f=fixture();
 const build=f.entries.find(e=>e.index===5);
 build.command=command(`const fs=require('node:fs');if(!fs.existsSync(${JSON.stringify(join(f.dir,'barriers/2.end'))}))throw Error('build before typecheck');fs.writeFileSync(${JSON.stringify(join(f.dir,'barriers/5.end'))},'');process.exitCode=3;`);
 execute(f);const collected=collect(f);assert.equal(collected.status,0,collected.stderr);
 const record=JSON.parse(readFileSync(join(f.dir,'result.json')));
 assert.equal(record.result,'failed');assert.equal(record.commands.length,5);
 assert.equal(record.commands.find(e=>e.name==='gate 5').status,'failed');
 assert.equal(record.commands.find(e=>e.name==='gate 6').status,'passed');
 assert.ok(existsSync(join(f.dir,'barriers/6.end')));
});
