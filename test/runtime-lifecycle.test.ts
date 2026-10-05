import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {startCodexProcess} from "../src/codex/process.js";
import {startRoutewire} from "../src/runtime.js";
import {Client, StreamableHTTPClientTransport} from "@modelcontextprotocol/client";
import {MODERN_MCP_PROTOCOL_VERSION} from "../src/mcp/modern.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close();});
async function helper(code: string) {
  const dir = await mkdtemp(join(tmpdir(), "routewire-lifecycle-"));
  cleanup.push(() => rm(dir, {recursive: true, force: true}));
  const command = join(dir, "codex");
  await writeFile(command, `#!${process.execPath}\n${code}`, {mode: 0o755});
  return {dir, command};
}

const initial = `const args=process.argv.slice(2);
if (args[0]==='app-server') process.exit(0);
const base=/base_url="([^" ]+)"/.exec(args.find(s=>s.startsWith('model_providers.routewire=')))[1];
const model=args[args.indexOf('-m')+1];
const tools={type:'additional_tools',tools:[{type:'namespace',name:'functions',tools:[{type:'custom',name:'exec',description:'exec'}]}]};
const request = async input => (await fetch(base+'/responses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model,input:[tools,...input]})})).text();`;

describe("runtime failure recovery", () => {
  it("refreshes late CUA registration on both MCP surfaces and routes the direct call", async () => {
    const {dir, command} = await helper(`(async()=>{${initial}
      let output=[], cycle=0;
      while(true) {
        const sse=await request(output);
        const event=sse.split('\\n').filter(x=>x.startsWith('data:')).map(x=>JSON.parse(x.slice(5))).find(x=>x.item);
        if(event.item.type!=='custom_tool_call') break;
        const inventory=++cycle>=3?[{name:'mcp__cua_repl__js',description:'CUA'}]:[];
        const text=event.item.input.includes('__ROUTEWIRE_NATIVE_INVENTORY_START__')?'__ROUTEWIRE_NATIVE_INVENTORY_START__'+JSON.stringify(inventory)+'__ROUTEWIRE_NATIVE_INVENTORY_END__':'CUA_READY';
        output=[{type:'custom_tool_call_output',call_id:event.item.call_id,output:[{type:'input_text',text}]}];
      }
    })().catch(()=>process.exit(24));`);
    const runtime=await startRoutewire({cwd:dir,codexHome:dir,model:"test",modelCatalog:[],codexCommand:command,quietCodex:true});
    cleanup.push(()=>runtime.close());
    const client=new Client({name:"late-tools",version:"0"});
    await client.connect(new StreamableHTTPClientTransport(new URL(runtime.mcpUrl)));
    cleanup.push(()=>client.close());
    const modern=await fetch(runtime.mcpUrl,{method:"POST",headers:{"content-type":"application/json","mcp-protocol-version":MODERN_MCP_PROTOCOL_VERSION,"mcp-method":"tools/list"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list",params:{_meta:{"io.modelcontextprotocol/protocolVersion":MODERN_MCP_PROTOCOL_VERSION}}})});
    expect((await modern.json()).result.tools.map((tool:{name:string})=>tool.name)).toContain("mcp__cua_repl__js");
    expect((await client.listTools()).tools.map(tool=>tool.name)).toContain("mcp__cua_repl__js");
    const result=await client.callTool({name:"mcp__cua_repl__js",arguments:{code:"await cua.getState();"}});
    expect(result.content).toEqual([{type:"text",text:"CUA_READY"}]);
  });
  it("drains quiet Codex stdout and stderr through process exit", async () => {
    const {dir, command} = await helper(`const fs=require('node:fs'); for(let i=0;i<128;i++){fs.writeSync(1,Buffer.alloc(65536));fs.writeSync(2,Buffer.alloc(65536));} process.exit(0);`);
    const child = startCodexProcess({cwd: dir, command, model: "test", providerBaseUrl: "http://localhost", quiet: true});
    cleanup.push(async () => {child.forceTerminate(); await child.exited;});
    await expect(Promise.race([child.exited, new Promise(resolve => setTimeout(() => resolve("blocked"), 2000))])).resolves.toMatchObject({code: 0});
  });

  it("rejects startup when Codex exits during discovery and releases the port", async () => {
    const {dir, command} = await helper(`(async()=>{${initial} await request([]); process.exit(23);})().catch(()=>process.exit(24));`);
    let url = "";
    const startup = startRoutewire({cwd: dir, codexHome: dir, model: "test", modelCatalog: [], codexCommand: command, quietCodex: true,
      onEvent: event => {if(event.type==='component' && event.component==='mcp' && event.state==='ready') url=event.detail!;},
    });
    await expect(Promise.race([startup, new Promise((_,reject)=>setTimeout(()=>reject(new Error("startup stayed pending")), 2000))])).rejects.toThrow(/exited.*23/);
    await expect(fetch(url)).rejects.toThrow();
  });

  it("bounds startup when a live Codex never requests the provider", async () => {
    const {dir, command} = await helper("setInterval(()=>{},1000);");
    await expect(startRoutewire({cwd: dir, codexHome: dir, modelCatalog: [], codexCommand: command, quietCodex: true,
      startupTimeoutMs: 100,
    })).rejects.toThrow(/startup.*timed out/i);
  });

  it("automatically closes the HTTP surface on unexpected exit after startup", async () => {
    const {dir, command} = await helper(`(async()=>{${initial}
      let output=[]; for(let i=0;i<2;i++){
        const sse=await request(output); const event=sse.split('\\n').filter(x=>x.startsWith('data:')).map(x=>JSON.parse(x.slice(5))).find(x=>x.item?.type==='custom_tool_call');
        output=[{type:'custom_tool_call_output',call_id:event.item.call_id,output:[{type:'input_text',text:'__ROUTEWIRE_NATIVE_INVENTORY_START__[]__ROUTEWIRE_NATIVE_INVENTORY_END__'}]}];
      }
      setTimeout(()=>process.exit(23), 500); await request(output);
    })().catch(()=>process.exit(24));`);
    const runtime = await startRoutewire({cwd:dir,codexHome:dir,model:"test",modelCatalog:[],codexCommand:command,quietCodex:true});
    cleanup.push(() => runtime.close());
    await runtime.codexExited;
    await expect.poll(async () => {
      try {await fetch(runtime.mcpUrl); return false;} catch {return true;}
    }).toBe(true);
    await runtime.close(); // Also joins the automatic cleanup.
    await expect(fetch(runtime.mcpUrl)).rejects.toThrow();
  });
});
