// 起動の入口。peers.json があればハブとして、ほかの端末のセッションもまとめて表示する。
import { config } from "./config.mjs";
import { isLoopbackHost } from "./auth.mjs";
import { Store } from "./store.mjs";
import { Peers, loadPeers } from "./peers.mjs";
import { createApp } from "./server.mjs";

if (!isLoopbackHost(config.host) && !config.token) {
  console.error(`CC_DASH_HOST=${config.host} で外から受け付けるには CC_DASH_TOKEN が必要です。`);
  process.exit(1);
}

const store = new Store();
await store.start();

const list = loadPeers();
const peers = list.length ? new Peers(list) : null;
peers?.start();

createApp(store, { peers }).listen(config.port, config.host, () => {
  console.log(`cc-dash [${config.name}]: http://${config.host}:${config.port}`);
  console.log(`  会話記録: ${config.projectsDir}`);
  console.log(`  イベント: ${config.eventsFile}`);
  console.log(`  Haiku 分類: ${config.llm ? "有効" : "無効（CC_DASH_LLM=1 で有効）"}`);
  if (peers) console.log(`  ハブ: ${list.map((p) => `${p.name}=${p.url}`).join(", ")}`);
  if (!isLoopbackHost(config.host)) console.log("  ループバック以外からのアクセスにはトークンが必要です");
});
