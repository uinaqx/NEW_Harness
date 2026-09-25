import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Test-only client: launch tokens and provider credentials are never logged. */
export class InstalledClient {
    events: Array<{name: string; payload: any}> = [];
    private socket!: WebSocket;
    private sequence = 0;
    private pending = new Map<string, {resolve: (data:any)=>void; reject:(e:Error)=>void}>();
    async connect(dataDir = join(process.env.LOCALAPPDATA!, "Harness", "data")) {
        const endpoint = JSON.parse(await readFile(join(dataDir, "runtime.json"), "utf8"));
        const health = await fetch(`http://127.0.0.1:${endpoint.port}/health`).then(r=>r.json()) as any;
        if (health.instanceId !== endpoint.instanceId) throw new Error("Stale application endpoint");
        this.socket = new WebSocket(`ws://127.0.0.1:${endpoint.port}/transport?token=${encodeURIComponent(endpoint.token)}`);
        await new Promise<void>((resolve,reject)=> {
            this.socket.onopen=()=>resolve();
            this.socket.onerror=()=>reject(new Error("Installed app connection failed"));
        });
        this.socket.onmessage=(event)=> {
            const value=JSON.parse(String(event.data));
            if(value.type === "event") { this.events.push(value.event); return; }
            const pending=this.pending.get(value.id);
            this.pending.delete(value.id);
            if(value.ok) pending?.resolve(value.result);
            else pending?.reject(new Error(value.error || "App command failed"));
        };
        return health;
    }
    async invoke(command:string,args:Record<string,unknown>={}):Promise<any> {
        const id=`acceptance-${++this.sequence}`;
        return new Promise((resolve,reject)=> {
            const timer=setTimeout(()=> { this.pending.delete(id); reject(new Error(`Timeout: ${command}`)); },60000);
            this.pending.set(id, {resolve:(v)=>{clearTimeout(timer);resolve(v)},reject:(e)=>{clearTimeout(timer);reject(e)}});
            this.socket.send(JSON.stringify({type:"command",id,command,args}));
        });
    }
    close() { this.socket?.close(); }
}
