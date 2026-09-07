// Usage: node scripts/verify-agent-efficiency.mjs <key-file> <native-backup-file>
// Sends bounded real portfolio evidence to the configured official DeepSeek service.
import 'fake-indexeddb/auto';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
if (!process.argv[2] || !process.argv[3]) { console.error('Usage: node scripts/verify-agent-efficiency.mjs <key-file> <native-backup-file>'); process.exit(1); }
const raw=(await readFile(process.argv[2],'utf8')).trim().replace(/^\uFEFF/, '');
let key;
try { const parsed=JSON.parse(raw); key=typeof parsed === 'string' ? parsed : parsed.api_key ?? parsed.apiKey ?? parsed.API_KEY ?? parsed.key; } catch { key=raw; }
if(typeof key !== 'string' || !key.trim() || /[\s{}]/.test(key.trim())) { console.error('Invalid local key file'); process.exit(1); }
key=key.trim();
await mkdir('output',{recursive:true});
const server=await createServer({configFile:false,server:{middlewareMode:true,hmr:false},appType:'custom'});
try{
const {runAgent}=await server.ssrLoadModule('/src/agent/runner.ts');
const {DEFAULT_AGENT_CONFIG}=await server.ssrLoadModule('/src/agent/types.ts');
const {parseNativePortableBackupText}=await server.ssrLoadModule('/src/data/portable-native.ts');
const {createEmptyDashboardData}=await server.ssrLoadModule('/src/ui/demoData.ts');
const preview=await parseNativePortableBackupText(await readFile(process.argv[3],'utf8'));
const p=preview.logicalPayload; const empty=createEmptyDashboardData();
const data={...empty,...p,settings:{...empty.settings,...p.settings,boundAccount:p.account}};
const config={...DEFAULT_AGENT_CONFIG,apiKey:key,shareData:true,timeoutSeconds:240};
const report=[];
for(const question of ['简洁告诉我作品总数、总浏览、总收藏，并引用来源。','简洁告诉我作品总数、总浏览、总收藏，并引用来源。','请用聚合简报分析现有观测范围的增长前三、粉丝净变化和内容类型结构，from 和 to 均用 null。简洁回答并引用来源。']){
 let content='',traces=[],usage;const start=Date.now();
 await runAgent(config,[{id:crypto.randomUUID(),role:'user',content:question,status:'complete',at:new Date().toISOString(),traces:[]}],data,false,AbortSignal.timeout(300000),{onText:t=>content+=t,onTrace:t=>traces.push(t),onBudget:()=>{},onUsage:u=>usage=u});
 if(!content.includes('[S')||!content.trim()||traces.some(t=>JSON.parse(t.result).error))throw new Error('Invalid evidence/citation');
 if(report.length<2){const normalize=content.replace(/[,，\s]/g,'');for(const n of [data.works.length,...['views','bookmarks'].map(k=>data.works.reduce((n,w)=>n+w.metrics[k],0))])if(!normalize.includes(String(n)))throw new Error('Numeric mismatch');}
 if(report.length===1&&!traces.some(t=>t.cached))throw new Error('Memory was not reused');
 if(report.length===2&&!traces.some(t=>t.name==='get_analysis_brief'))throw new Error('Aggregate tool not used');
 report.push({question,content,usage,elapsedMs:Date.now()-start,tools:traces.map(t=>({name:t.name,cached:t.cached,bytes:t.result.length}))});
 console.log(JSON.stringify({turn:report.length,usage,elapsedMs:Date.now()-start,tools:report.at(-1).tools}));
}
const output=JSON.stringify(report,null,2);if(output.includes(key))throw new Error('Secret leak');await writeFile('output/agent-052-live.json',output);
}catch(e){console.error(String(e.message).replaceAll(key,'[REDACTED]'));process.exitCode=1;}finally{await server.close()}
