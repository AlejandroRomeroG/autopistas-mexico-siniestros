import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
const project = new URL('../', import.meta.url);
await rm(new URL('docs/',project), { recursive: true, force: true });
await mkdir(new URL('docs/',project), { recursive: true });
await cp(new URL('src/',project), new URL('docs/',project), { recursive: true });
await cp(new URL('data/source/',project), new URL('docs/data/source/',project), { recursive: true });
await cp(new URL('data/source/source-audit.json',project), new URL('docs/data/audit.json',project));
await writeFile(new URL('docs/.nojekyll',project), '');
console.log('GitHub Pages listo en docs/');
