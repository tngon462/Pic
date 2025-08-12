// api/manifest.js
export const config = { api: { bodyParser: true } };

const GH_API = 'https://api.github.com';
const {
  GITHUB_TOKEN,
  GH_OWNER = 'tngon462',
  GH_REPO = 'slide',
  GH_BRANCH = 'main',
  MANIFEST_PATH = 'slides/manifest.json',
  CORS_ORIGIN = '*'
} = process.env;

function withCORS(req, res){
  const list = String(CORS_ORIGIN).split(',').map(s=>s.trim());
  const origin = req.headers.origin || '';
  const allow = list.includes('*') || list.includes(origin) ? (origin || '*') : list[0] || '*';
  res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Vary','Origin');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(200).end(); return true; }
  return false;
}

function toBase64(buf){ return Buffer.from(buf).toString('base64'); }

async function gh(path, init={}){
  const res = await fetch(`${GH_API}${path}`, {
    ...init,
    headers:{
      'Authorization':`Bearer ${GITHUB_TOKEN}`,
      'Accept':'application/vnd.github+json',
      'User-Agent':'slides-manager',
      ...(init.headers||{})
    }
  });
  if(!res.ok){
    throw new Error(`GitHub ${res.status} ${res.statusText}: ${await res.text()}`);
  }
  return res;
}

async function getFile(path, branch){
  try{
    const res = await gh(`/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`);
    return await res.json();
  }catch(e){
    if(String(e.message).includes('404')) return null;
    throw e;
  }
}

async function putFile(path, branch, contentBase64, message, sha){
  const body = { message, content: contentBase64, branch };
  if(sha) body.sha = sha;
  const res = await gh(`/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(path)}`, {
    method:'PUT',
    body: JSON.stringify(body)
  });
  return res.json(); // {commit:{sha}}
}

async function deleteFile(path, branch){
  const info = await getFile(path, branch);
  if(!info) return false;
  const res = await fetch(`${GH_API}/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(path)}`, {
    method:'DELETE',
    headers:{
      'Authorization':`Bearer ${GITHUB_TOKEN}`,
      'Accept':'application/vnd.github+json',
      'User-Agent':'slides-manager'
    },
    body: JSON.stringify({
      message: `chore(slides): delete ${path}`,
      sha: info.sha,
      branch
    })
  });
  if(!res.ok) throw new Error(`Delete file failed: ${res.status} ${await res.text()}`);
  await res.json();
  return true;
}

function normalizeToObjects(manifest){
  const arr = Array.isArray(manifest) ? manifest
            : (Array.isArray(manifest?.slides) ? manifest.slides : []);
  return arr.map(x => typeof x === 'string' ? ({src:x}) : ({...x}));
}

export default async function handler(req,res){
  if (withCORS(req, res)) return;
  try{
    if(!GITHUB_TOKEN) { res.status(500).json({error:'Thiếu GITHUB_TOKEN'}); return; }

    if(req.method === 'GET'){
      const mfFile = await getFile(MANIFEST_PATH, GH_BRANCH);
      if(!mfFile){
        return res.status(200).json({ items: [], schema: 'objects' });
      }
      const manifest = JSON.parse(Buffer.from(mfFile.content, mfFile.encoding).toString('utf8'));
      const items = normalizeToObjects(manifest);
      return res.status(200).json({ items, schema: 'objects' });
    }

    if(req.method === 'PUT'){
      const { items, delete_files = false } = req.body || {};
      if(!Array.isArray(items)) { res.status(400).json({error:'Payload phải có items[]'}); return; }

      const mfFile = await getFile(MANIFEST_PATH, GH_BRANCH);
      const oldManifest = mfFile ? JSON.parse(Buffer.from(mfFile.content, mfFile.encoding).toString('utf8')) : [];
      const oldItems = normalizeToObjects(oldManifest);
      const oldSrcs = new Set(oldItems.map(x=>x.src));
      const newSrcs = new Set(items.map(x=>x.src));
      const removedList = [...oldSrcs].filter(x => !newSrcs.has(x));

      const content = JSON.stringify(items, null, 2);
      const out = await putFile(MANIFEST_PATH, GH_BRANCH, toBase64(Buffer.from(content,'utf8')),
                                `chore(manifest): save (${items.length} items)`, mfFile?.sha);

      let deletedFiles = 0;
      if(delete_files && removedList.length){
        for(const p of removedList){
          try{
            const ok = await deleteFile(p, GH_BRANCH);
            if(ok) deletedFiles++;
          }catch(e){}
        }
      }

      res.status(200).json({
        commitSha: out.commit.sha,
        removed: removedList.length,
        deletedFiles
      });
      return;
    }

    res.status(405).json({error:'Method not allowed'});
  }catch(e){
    res.status(500).json({ error: e.message });
  }
}
