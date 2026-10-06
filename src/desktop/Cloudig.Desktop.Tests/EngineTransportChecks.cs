using System.Text.Json;
using Cloudig.Desktop.Core;

internal static class EngineTransportChecks
{
    public static async Task RunAsync(string scope, string node)
    {
        var script = Path.Combine(scope, "transport-fault-engine.mjs");
        await File.WriteAllTextAsync(script, """
import readline from 'node:readline';
const protocol='cloudig/engine-ipc/1.0.0';
const cache=process.argv[process.argv.indexOf('--cache-root')+1];
const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
let largeSeen=false;
const respond=(request,result)=>process.stdout.write(JSON.stringify({protocol,kind:'response',request,ok:true,result})+'\n');
for await(const line of lines){
  const r=JSON.parse(line);
  if(r.command==='engine.handshake') respond(r.request,{protocol});
  else if(r.command==='engine.storage') respond(r.request,{runtime_root:cache+'\\fixture'});
  else if(r.command==='test.missing-result') process.stdout.write(JSON.stringify({protocol,kind:'response',request:r.request,ok:true})+'\n');
  else if(r.command==='test.invalid-json') process.stdout.write('invalid response\n');
  else if(r.command==='test.event') {
    process.stdout.write(JSON.stringify({protocol,kind:'event',request:r.request,event:{phase:'read'}})+'\n');
    respond(r.request,{});
  }
  else if(r.command==='test.pause') { lines.pause(); respond(r.request,{}); setTimeout(()=>lines.resume(),500); }
  else if(r.command==='test.large') { largeSeen=r.payload.text.length===750000; respond(r.request,{}); }
  else if(r.command==='test.echo') respond(r.request,{...r.payload,largeSeen});
  else if(r.command==='engine.shutdown') { respond(r.request,{}); break; }
}
""");
        var failures = new List<string>();
        foreach (var fault in new[] { "missing-result", "invalid-json", "event" })
        {
            await using var client = await EngineJsonlClient.StartAsync(node, script, scope, Path.Combine(scope, "cache"));
            var payload = JsonSerializer.SerializeToElement(new { });
            var first = fault == "event"
                ? client.SendWithEventsAsync("test.event", payload, _ => throw new InvalidDataException("Invalid progress event."))
                : client.SendAsync("test." + fault, payload);
            await ExpectFailureAsync(first, fault + " pending request", failures);
            var later = client.SendAsync("test.echo", payload);
            await ExpectFailureAsync(later, fault + " later request", failures);
        }
        await using (var client = await EngineJsonlClient.StartAsync(node, script, scope, Path.Combine(scope, "cache")))
        {
            await client.SendAsync("test.pause", JsonSerializer.SerializeToElement(new { }));
            using var cancel = new CancellationTokenSource(TimeSpan.FromMilliseconds(30));
            var large = client.SendAsync("test.large", JsonSerializer.SerializeToElement(new { text = new string('x', 750000) }), cancel.Token);
            try { await large.WaitAsync(TimeSpan.FromMilliseconds(300)); failures.Add("a blocked write did not report caller cancellation"); }
            catch (OperationCanceledException) { }
            catch (TimeoutException) { failures.Add("caller cancellation waited for the blocked pipe write"); }
            try
            {
                var next = await client.SendAsync("test.echo", JsonSerializer.SerializeToElement(new { after = true })).WaitAsync(TimeSpan.FromSeconds(3));
                if (!next.GetProperty("after").GetBoolean() || !next.GetProperty("largeSeen").GetBoolean()) failures.Add("cancelled dispatch did not preserve the complete JSON frame");
            }
            catch (Exception error) { failures.Add("write cancellation corrupted the next request: " + error.Message); }
        }
        if (failures.Count > 0) throw new InvalidOperationException(string.Join("; ", failures));
        Console.WriteLine("Engine transport: terminal failures and cancelled frame boundaries passed (8 checks).");
    }

    private static async Task ExpectFailureAsync(Task<JsonElement> task, string label, List<string> failures)
    {
        try
        {
            await task.WaitAsync(TimeSpan.FromSeconds(2));
            failures.Add(label + " unexpectedly succeeded");
        }
        catch (TimeoutException)
        {
            failures.Add(label + " stayed pending after the response reader failed");
            _ = task.ContinueWith(done => _ = done.Exception, TaskContinuationOptions.OnlyOnFaulted);
        }
        catch (OperationCanceledException) { failures.Add(label + " hid the transport failure as user cancellation"); }
        catch (Exception error)
        {
            if (error is not EngineRemoteException { Code: "CLOUDIG_ENGINE_UNAVAILABLE" }) failures.Add(label + " did not identify the failed Engine connection");
        }
    }
}
