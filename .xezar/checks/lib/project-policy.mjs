// Xezar SDLC's additional project merge gate. Hosting policy is independently enforced.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// A design-only PR (every changed file under paths.designs) must not close its issue (#207): GitHub
// closes every issue in closingIssuesReferences on merge, also from a sentence that says it does
// not, and the implementation is still to come. Checked only when the input carries `files` and
// `closingIssuesReferences` (gh pr view --json) and the project names paths.designs.
function designOnlyCloses(pr, designs) {
  if (typeof designs !== 'string' || !designs.trim() || !Array.isArray(pr?.files) || !pr.files.length || !Array.isArray(pr?.closingIssuesReferences)) return '';
  const dir = designs.replace(/^\.\//, '').replace(/\/+$/, '') + '/';
  if (!pr.files.every(f => typeof f?.path === 'string' && f.path.startsWith(dir))) return '';
  const closes = pr.closingIssuesReferences.map(i => `#${i?.number}`);
  return closes.length ? `a design-only PR closes ${closes.join(', ')} on merge; it links its issue with "Refs #N" only and never puts a closing word next to the number` : '';
}
export function projectPolicy(pr, { designs } = {}) {
  if(!Array.isArray(pr?.labels) || pr.labels.some(l=>typeof l?.name!=='string')) return {unavailable:'PR labels missing or malformed'};
  const labels=new Set(pr.labels.map(l=>l.name));
  for(const label of ['blocked','do-not-merge','qa','qa-failed','design','design-failed']) if(labels.has(label)) return {refused:`SDLC label ${label} blocks merge`};
  if(labels.has('needs-qa') && labels.has('skip-qa'))return {refused:'needs-qa and skip-qa conflict'};
  if(labels.has('needs-qa')&&!labels.has('qa-approved'))return {refused:'needs-qa requires qa-approved backed by reviewer evidence'};
  // The design gate (SDLC.md § The design gate) mirrors the QA gate; neither approval satisfies the other.
  if(labels.has('needs-design') && labels.has('skip-design'))return {refused:'needs-design and skip-design conflict'};
  if(labels.has('needs-design')&&!labels.has('design-approved'))return {refused:'needs-design requires design-approved backed by the "## Design review" evidence'};
  const closes=designOnlyCloses(pr, designs);
  if(closes)return {refused:closes};
  return {passed:true};
}
// paths.designs from the project's own config, read from the working directory the leader runs in.
function configuredDesigns() {
  try { const p=join(process.cwd(),'.xezar/pipeline/config.json'); return existsSync(p) ? JSON.parse(readFileSync(p,'utf8'))?.paths?.designs : undefined; } catch { return undefined; }
}
const isMain = (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if(isMain){let input='';for await(const chunk of process.stdin)input+=chunk;try{console.log(JSON.stringify(projectPolicy(JSON.parse(input),{designs:configuredDesigns()})));}catch{console.log(JSON.stringify({unavailable:'PR response is not valid JSON'}));}}
