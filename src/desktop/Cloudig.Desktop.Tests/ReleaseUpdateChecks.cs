using System.Net;
using System.Text.Json;
using Cloudig.Desktop.Core;

internal static class ReleaseUpdateChecks
{
    internal static void CheckPublishedAssembly(string file)
    {
        var context = new System.Runtime.Loader.AssemblyLoadContext("published-update-client", isCollectible: true);
        try
        {
            var assembly = context.LoadFromAssemblyPath(Path.GetFullPath(file));
            var compare = assembly.GetType("Cloudig.Desktop.Core.ReleaseUpdateClient", throwOnError: true)!
                .GetMethod("CompareStableRelease", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static)!;
            var cases = new[] { ("1.0.0", "v1.0.1", "available"), ("1.0.1", "v1.0.1", "current"),
                ("1.0.0", "v1.0.2", "available"), ("1.0.1", "v1.0.2", "available"), ("1.0.2", "v1.0.2", "current") };
            foreach (var (current, latest, expected) in cases)
                if (!Equals(compare.Invoke(null, [current, latest]), expected))
                    throw new Exception($"Published updater cannot compare {current} to {latest}");
            Console.WriteLine(JsonSerializer.Serialize(new { published_assembly = Path.GetFullPath(file), checks = cases.Select(c => new { current = c.Item1, latest = c.Item2, status = c.Item3 }) }));
        }
        finally { context.Unload(); }
    }

    internal sealed class Handler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) => send(request, token);
    }
    internal static async Task RunAsync()
    {
        var count=0;
        void Equal<T>(T actual,T expected) { count++; if(!EqualityComparer<T>.Default.Equals(actual,expected))throw new Exception($"Update check {count}: {actual} != {expected}"); }
        foreach(var (current,latest,status) in new[]{
            ("1.0.0-dev","v1.0.0","available"),("1.9.0","v1.10.0","available"),("2.0.0","v1.99.99","ahead"),
            ("1.0.0","v1.0.1","available"),("1.0.1","v1.0.1","current"),
            ("1.0.0","v1.0.2","available"),("1.0.1","v1.0.2","available"),("1.0.2","v1.0.2","current"),
            ("1.0.0+build","V1.0","current"),("1.2.3","1.2.4","available"),("1.2.3","1.2.2","ahead"),
            ("1.0.0","v1.1.0-rc.1","invalid_version"),("not-a-version","1.0.0","invalid_version"),
            ("1.0.0","https://evil.example/","invalid_version"),("1.0.0","1.01.0","invalid_version"),
            ("1.0.0",new string('1',129),"invalid_version"),("1.0.0","999999999999.0.0","invalid_version")})
            Equal(ReleaseUpdateClient.CompareStableRelease(current,latest),status);
        static HttpResponseMessage Response(HttpStatusCode status,string body="{}") => new(status){Content=new StringContent(body)};
        static string Release(string tag="v1.1.0",bool draft=false,bool prerelease=false)=>JsonSerializer.Serialize(new{tag_name=tag,draft,prerelease,published_at="2026-09-21T00:00:00Z",html_url="https://evil.example/ignored"});
        async Task<ReleaseUpdateResult> Check(Func<HttpRequestMessage,CancellationToken,Task<HttpResponseMessage>> send,CancellationToken token=default)
        {
            using var http=new HttpClient(new Handler(send));
            return await new ReleaseUpdateClient(http).CheckAsync("1.0.0",token);
        }
        var seen=new List<string>();
        var noRelease=await Check((request,_)=>{
            Equal(request.Method,HttpMethod.Get);Equal(request.Headers.Authorization,null);Equal(request.Content,null);
            Equal(request.Headers.UserAgent.ToString(),"Cloudig/1.0");Equal(request.Headers.Accept.ToString(),"application/vnd.github+json");
            seen.Add(request.RequestUri!.AbsoluteUri);
            return Task.FromResult(Response(seen.Count==1?HttpStatusCode.NotFound:HttpStatusCode.OK));
        });
        Equal(noRelease.Status,"no_release");Equal(seen.Count,2);Equal(seen[0],ReleaseUpdateClient.LatestApi);Equal(seen[1],ReleaseUpdateClient.RepositoryApi);
        Equal((await Check((_,_)=>Task.FromResult(Response(HttpStatusCode.NotFound)))).Status,"unavailable");
        foreach(var status in new[]{HttpStatusCode.Forbidden,HttpStatusCode.TooManyRequests})Equal((await Check((_,_)=>Task.FromResult(Response(status)))).Status,"rate_limited");
        foreach(var status in new[]{HttpStatusCode.InternalServerError,HttpStatusCode.Redirect})Equal((await Check((_,_)=>Task.FromResult(Response(status)))).Status,"unavailable");
        foreach(var body in new[]{"<html>blocked</html>","[]","{}",Release(draft:true),Release(prerelease:true),"{\"draft\":false,\"prerelease\":false,\"tag_name\":\"v1.0.0\",\"published_at\":null}"})
            Equal((await Check((_,_)=>Task.FromResult(Response(HttpStatusCode.OK,body)))).Status,"invalid_response");
        Equal((await Check((_,_)=>Task.FromResult(Response(HttpStatusCode.OK,Release("v2.0.0"))))).Status,"available");
        Equal((await Check((_,_)=>Task.FromResult(Response(HttpStatusCode.OK,Release("v1.0.0"))))).Status,"current");
        Equal((await Check((_,_)=>Task.FromResult(Response(HttpStatusCode.OK,Release("v0.9.0"))))).Status,"ahead");
        Equal((await Check((_,_)=>Task.FromResult(Response(HttpStatusCode.OK,Release("bad"))))).Status,"invalid_version");
        Equal((await Check((_,_)=>throw new HttpRequestException())).Status,"unavailable");
        Equal((await Check((_,_)=>throw new TaskCanceledException())).Status,"timeout");
        foreach(var declared in new[]{true,false}){
            var response=Response(HttpStatusCode.OK,new string('x',ReleaseUpdateClient.MaximumResponseBytes+1));
            if(!declared)response.Content=new StreamContent(new MemoryStream(new byte[ReleaseUpdateClient.MaximumResponseBytes+1]));
            Equal((await Check((_,_)=>Task.FromResult(response))).Status,"invalid_response");
        }
        using var cancel=new CancellationTokenSource();
        var waiting=Check(async(_,token)=>{cancel.Cancel();await Task.Delay(Timeout.Infinite,token);return Response(HttpStatusCode.OK);},cancel.Token);
        try {await waiting;throw new Exception("Cancellation ignored");}catch(OperationCanceledException){count++;}
        using var unused=new HttpClient(new Handler((_,_)=>throw new Exception("Invalid local version must not request the network")));
        Equal((await new ReleaseUpdateClient(unused).CheckAsync(null)).Status,"invalid_version");
        Console.WriteLine($"Release update checks passed: {count}");
    }
}
