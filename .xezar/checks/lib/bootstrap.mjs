import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const git=(...args)=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const source=fs.realpathSync(process.argv[2]);
const cwd=fs.realpathSync(git('rev-parse','--show-toplevel'));
const main=fs.realpathSync(path.dirname(git('rev-parse','--path-format=absolute','--git-common-dir')));
if(source!==path.join(main,'.xezar')) throw Error('bootstrap source must be this repository primary kit');
if(cwd===main){console.log('KIT AVAILABLE: primary checkout; no files copied');process.exit(0);}
const run=path.basename(cwd);
if(path.dirname(cwd)!==path.join(main,'.local/xezar/worktrees') || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(run)) throw Error('not a Xezar task worktree');
if(git('branch','--show-current')!==`xez/${run.slice(0,8)}`) throw Error('task branch identity mismatch');
if(process.env.XEZ_TASK_ID && process.env.XEZ_TASK_ID!==run) throw Error('task environment identity mismatch');
const target=path.join(cwd,'.xezar');
// Refuse symlink traversal in both source and destination; never overwrite task edits.
function safeParents(base,rel){let cur=base;for(const part of path.normalize(rel).split(path.sep)){cur=path.join(cur,part);try{if(fs.lstatSync(cur).isSymbolicLink())throw Error(`symlink refused: ${rel}`);}catch(e){if(e.code!=='ENOENT')throw e;}}}
safeParents(cwd,'.xezar');fs.mkdirSync(target,{recursive:true});
safeParents(cwd,'.local/xezar/cache/kit');
const local=path.join(cwd,'.local/xezar/cache/kit');fs.mkdirSync(local,{recursive:true});
// The review's own scripts (D13; see review-run.sh, "Which copy runs"): the primary's checks/, copied outside the tracked
// tree on every kit step, so a review that checks a PR head out (which replaces .xezar/checks/) still runs this kit.
{const trusted=path.join(local,'checks'),stage=`${trusted}.stage-${process.pid}`;let n=0;safeParents(source,'checks');
 const copy=(from,to)=>{fs.mkdirSync(to,{mode:0o755});for(const f of fs.readdirSync(from).sort()){const s=path.join(from,f),d=path.join(to,f),st=fs.lstatSync(s);if(st.isDirectory())copy(s,d);else if(st.isFile()){fs.writeFileSync(d,fs.readFileSync(s),{flag:'wx',mode:st.mode&0o777});n++;}else throw Error(`not a regular kit asset: ${path.relative(source,s).split(path.sep).join('/')}`);}};
 fs.rmSync(stage,{recursive:true,force:true});copy(path.join(source,'checks'),stage);fs.rmSync(trusted,{recursive:true,force:true});fs.renameSync(stage,trusted);
 console.log(`REVIEW TOOLS: ${n} kit checks copied from the primary checkout to .local/xezar/cache/kit/checks`);}
const record=path.join(local,'snapshot.json');
if(fs.existsSync(record)){if(fs.lstatSync(record).isSymbolicLink())throw Error('snapshot symlink');const saved=JSON.parse(fs.readFileSync(record));if(saved.run!==run)throw Error('snapshot owner mismatch');console.log(`KIT REUSED: ${saved.digest}; preserves task-local edits`);process.exit(0);}
const entries=[];
function walk(rel){safeParents(source,rel);const stat=fs.lstatSync(path.join(source,rel));if(stat.isDirectory()){for(const f of fs.readdirSync(path.join(source,rel)).sort())walk(path.join(rel,f));}else if(stat.isFile())entries.push(rel.split(path.sep).join('/'));else throw Error(`not a regular kit asset: ${rel}`);}
for(const rel of ['checks','skills','workflows','docs','config.json','CLAUDE.md','kit-manifest.json'])if(fs.existsSync(path.join(source,rel)))walk(rel);
const lock=path.join(local,'bootstrap-lock');fs.mkdirSync(lock);
try{
 const content=entries.map(rel=>({rel,bytes:fs.readFileSync(path.join(source,rel)),mode:fs.statSync(path.join(source,rel)).mode&0o777}));
 // A differing task copy is kept only when it is the fork base's own blob (the primary checkout lags a merged kit PR);
 // a file the branch itself changed is refused. No origin/<base> or merge base: refuse (fail closed).
 let forkBase;const atBase=(rel,dest)=>{if(forkBase===undefined){let base='';try{base=JSON.parse(fs.readFileSync(path.join(source,'config.json'),'utf8')).baseBranch?.trim()||'';}catch{}
  try{if(!base)base=git('symbolic-ref','--quiet','--short','refs/remotes/origin/HEAD').replace(/^origin\//,'');forkBase=git('merge-base','HEAD',`refs/remotes/origin/${base}`);}catch{forkBase='';}}
  if(!forkBase)return false;try{return git('rev-parse',`${forkBase}:.xezar/${rel.split(path.sep).join('/')}`)===git('hash-object','--',dest);}catch{return false;}};
 let kept=0;
 for(const f of content){safeParents(target,f.rel);const dest=path.join(target,f.rel);if(fs.existsSync(dest)&&(!fs.lstatSync(dest).isFile()||!fs.readFileSync(dest).equals(f.bytes))){if(fs.lstatSync(dest).isFile()&&atBase(f.rel,dest)){kept++;continue;}throw Error(`existing task asset differs: ${f.rel}; reconcile deliberately`);}}
 for(const f of content){const dest=path.join(target,f.rel);fs.mkdirSync(path.dirname(dest),{recursive:true});if(!fs.existsSync(dest))fs.writeFileSync(dest,f.bytes,{flag:'wx',mode:f.mode});}
 const digest=crypto.createHash('sha256');for(const f of content){digest.update(f.rel+'\0');digest.update(f.bytes);}
 fs.writeFileSync(record,JSON.stringify({version:1,run,digest:digest.digest('hex'),files:content.map(f=>f.rel)},null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(`KIT SNAPSHOTTED: ${content.length} assets (${kept} kept at the fork base); no application code or runtime copied`);
}finally{fs.rmdirSync(lock);}
