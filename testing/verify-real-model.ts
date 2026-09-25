/** Run only after the user configures their endpoint in the installed app. */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InstalledClient } from "./installed-client";

const client=new InstalledClient();
const report:any={startedAt:new Date().toISOString(),mode:"real-model",passed:false};
try {
    const health=await client.connect();
    const {settings}=await client.invoke("get_model_settings");
    if(!settings.hasApiKey) throw new Error("Configure a provider in the app first");
    report.protocol=settings.protocol; report.model=settings.model; report.appVersion=health.appVersion;
    const connection=await client.invoke("test_model_connection");
    report.connection=connection;
    const workspace=await mkdtemp(join(tmpdir(),"Harness-real-"));
    report.workspace=workspace;
    await writeFile(join(workspace,"Add.ps1"),"function Add-Numbers($a, $b) { return $a - $b }\n");
    await writeFile(join(workspace,"test.ps1"),". $PSScriptRoot/Add.ps1\nif ((Add-Numbers 2 3) -ne 5) { throw 'Expected 5' }\nWrite-Output 'HARNESS_TEST_PASSED'\n");
    await writeFile(join(workspace,"README.md"),"Fix Add-Numbers so it adds its two arguments. Do not change test.ps1. Run powershell.exe -NoProfile -File ./test.ps1.\n");
    const git=Bun.spawnSync(["git","init",workspace],{stdout:"ignore",stderr:"ignore",windowsHide:true});
    if(git.exitCode!==0) throw new Error("Cannot initialise isolated test repository");
    for (const args of [["config","user.name","Harness Verification"],["config","user.email","harness-test@example.invalid"],["add","."],["commit","-m","Initial test fixture"]]) {
        const step=Bun.spawnSync(["git","-C",workspace,...args],{stdout:"ignore",stderr:"pipe",windowsHide:true});
        if(step.exitCode!==0) throw new Error(`Cannot prepare isolated test repository: git ${args[0]}`);
    }
    const {session}=await client.invoke("create_session",{workspaceRoot:workspace});
    report.sessionId=session.id;
    const prompt="仅在当前临时测试项目内操作：先读取 README.md、Add.ps1 和 test.ps1，修复 Add-Numbers 的加法错误，不要修改测试。执行 powershell.exe -NoProfile -File ./test.ps1，确认 HARNESS_TEST_PASSED，最后用中文简述修改和测试结果。不要访问项目外文件、网络或安装依赖。";
    await client.invoke("chat_session_command",{action:"send",sessionId:session.id,prompt});
    console.log(`Real acceptance started: ${settings.protocol}; session=${session.id}; workspace=${workspace}`);
    let cursor=0,done=false;
    const approved=new Set<string>();
    const deadline=Date.now()+600000;
    report.approvals=[]; report.tools=[];
    while(Date.now()<deadline && !done) {
        const batch=client.events.slice(cursor);
        cursor+=batch.length;
        for(const event of batch) {
            if(event.payload.sessionId!==session.id) continue;
            if(event.name==="tool_approval_state") for(const item of event.payload.approvals??[]) {
                if(approved.has(item.requestId)) continue;
                const permission=item.input?.permission;
                const metadata=item.input?.metadata??{};
                const filepath=typeof metadata.filepath==="string"?resolve(workspace,metadata.filepath):"";
                const inside=filepath.startsWith(resolve(workspace)+"\\");
                const command=typeof metadata.command==="string"?metadata.command.trim():"";
                // A model may propose arbitrary actions. Only the expected fixture edit
                // and exact test command are authorised in this isolated workspace.
                const allow=permission==="edit" && inside && filepath.toLowerCase()===join(workspace,"Add.ps1").toLowerCase()
                    || permission==="bash" && command.toLowerCase()==="powershell.exe -noprofile -file ./test.ps1";
                approved.add(item.requestId);
                report.approvals.push({tool:item.toolName,permission,decision:allow?"allow":"reject"});
                console.log(`Permission: ${permission} -> ${allow?"allow":"reject"}`);
                await client.invoke("resolve_tool_approval",{sessionId:session.id,requestId:item.requestId,decision:allow?"allow":"reject"});
            }
            if(event.name==="chat_event" && event.payload.stream==="chat_tool_call_end") {
                const tool=JSON.parse(event.payload.chunk);
                report.tools.push({toolName:tool.toolName,status:tool.status});
            }
            if(event.name==="chat_event" && event.payload.stream==="chat_done") {
                const completion=JSON.parse(event.payload.chunk);
                report.completion={reason:completion.reason}; done=true;
            }
        }
        await Bun.sleep(150);
    }
    if(!done) { await client.invoke("chat_session_command",{action:"stop",sessionId:session.id}); throw new Error("Real acceptance timed out"); }
    const content=await readFile(join(workspace,"Add.ps1"),"utf8");
    const test=Bun.spawnSync(["powershell.exe","-NoProfile","-File",join(workspace,"test.ps1")],{cwd:workspace,stdout:"pipe",stderr:"pipe",windowsHide:true});
    report.independentTest={exitCode:test.exitCode,passed:test.stdout.toString().includes("HARNESS_TEST_PASSED")};
    report.diffs=(await client.invoke("list_session_diffs",{sessionId:session.id})).diffs?.map((diff:any)=>({file:diff.file,additions:diff.additions,deletions:diff.deletions}));
    report.passed=report.completion?.reason==="completed" && content.includes("+") && report.independentTest.passed && report.tools.some((t:any)=>t.toolName==="bash") && report.approvals.some((a:any)=>a.permission==="edit") && report.approvals.some((a:any)=>a.permission==="bash");
    console.log(`Real acceptance: ${report.passed?"PASS":"FAIL"}; tools=${report.tools.length}`);
} catch(error) {
    report.error=error instanceof Error?error.message:String(error);
    console.log(`Real acceptance failed: ${report.error}`);
} finally {
    client.close();
    const path=join(import.meta.dir,`real-model-${report.protocol??"unconfigured"}-${Date.now()}.json`);
    await writeFile(path,JSON.stringify(report,null,2));
    console.log(`Report: ${path}`);
}
process.exit(report.passed?0:1);
