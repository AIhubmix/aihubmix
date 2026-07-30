// H1 regression: internal cluster topology must never surface through display
// fields or the error channel. Pure-function checks over the built output — no
// network, no key. Guards isPublicHost() / redactInternal() / displayBase().
import { isPublicHost, redactInternal, displayBase } from "../dist/aihubmix.js";

let passed = 0;
let failed = 0;
function report(name, ok, detail) {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? passed++ : failed++;
}
const eq = (name, got, want) => report(name, got === want, got === want ? "" : `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

// --- isPublicHost: fail-closed (only provably-public hosts are true) ---
eq("public FQDN aihubmix.com", isPublicHost("aihubmix.com"), true);
eq("public FQDN api.inferera.com", isPublicHost("api.inferera.com"), true);
eq("public IPv4 8.8.8.8", isPublicHost("8.8.8.8"), true);
eq("k8s svc dns", isPublicHost("one-api-service.one-api-prod.svc.cluster.local"), false);
eq("bare service name", isPublicHost("one-api-service"), false);
eq("*.local", isPublicHost("gateway.local"), false);
eq("*.internal", isPublicHost("db.internal"), false);
eq("RFC1918 10/8", isPublicHost("10.1.2.3"), false);
eq("RFC1918 172.16/12", isPublicHost("172.20.0.5"), false);
eq("RFC1918 192.168/16", isPublicHost("192.168.1.1"), false);
eq("CGNAT 100.64/10", isPublicHost("100.64.0.1"), false);
eq("link-local 169.254", isPublicHost("169.254.1.1"), false);
eq("loopback 127", isPublicHost("127.0.0.1"), false);
eq("localhost", isPublicHost("localhost"), false);
eq("IPv6 loopback ::1", isPublicHost("[::1]"), false);
eq("IPv6 ULA fc/fd", isPublicHost("[fd12:3456:789a::1]"), false);
eq("IPv6 link-local fe80", isPublicHost("[fe80::1]"), false);
eq("empty host", isPublicHost(""), false);

// --- redactInternal: scrub internal URLs / DNS / IPs, keep public ones ---
const leaky = "request to http://one-api-service.one-api-prod.svc.cluster.local/v1/chat/completions failed: connect ECONNREFUSED 10.1.2.3:80";
const red = redactInternal(leaky);
report("redact drops internal FQDN", !/cluster\.local/.test(red), red);
report("redact drops private IP", !/10\.1\.2\.3/.test(red), red);
report("redact inserts labels", /\[internal-endpoint\]/.test(red) && /\[internal-ip\]/.test(red), red);
report("redact keeps public URL", /https:\/\/aihubmix\.com/.test(redactInternal("HTTP 500 from https://aihubmix.com/v1/models: {\"error\":\"x\"}")));
report("redact scheme-less k8s host", redactInternal("dial one-api.ns.svc.cluster.local:8080 refused").includes("[internal-host]"));
eq("redact empty passthrough", redactInternal(""), "");

// --- displayBase: publicBases whitelist OR structurally-public, else masked ---
const pub = ["https://aihubmix.com", "https://api.inferera.com"];
eq("displayBase whitelisted", displayBase("https://aihubmix.com/x", pub), "https://aihubmix.com/x");
eq("displayBase public non-listed", displayBase("https://my-proxy.example.com", pub), "https://my-proxy.example.com");
eq("displayBase internal masked", displayBase("http://one-api.one-api-prod.svc.cluster.local", pub), "in-cluster-direct");
eq("displayBase private-ip masked", displayBase("http://10.0.0.5:3000", pub), "in-cluster-direct");
eq("displayBase hosted entrance shown", displayBase("https://shkq.org", ["https://shkq.org"]), "https://shkq.org");
eq("displayBase unparseable masked", displayBase("not a url", pub), "in-cluster-direct");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
