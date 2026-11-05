// Temporary: checks text quality with short snippets only.
import { pageBlocks, parseRSS } from './collect.mjs';
const hit=async u=>{const r=await fetch(u,{headers:{'User-Agent':'NorthBankReader/1.0 (personal news reader)'},signal:AbortSignal.timeout(20000)});return r.text()};
const show=(n,bl)=>{console.log(`== ${n}: ${bl.length} blocks`);bl.slice(0,4).concat(bl.slice(-5)).forEach(b=>console.log(' ',b.t,(b.text||b.src||'').slice(0,46)))};
const g=parseRSS(await hit('https://www.theguardian.com/football/arsenal/rss'));
console.log('guardian rss img',!!g[0].image,'byline',g[0].byline,'trail',g[0].trail.slice(0,40));
show('guardian '+g[0].url.slice(-40),pageBlocks(await hit(g[0].url)));
const b=parseRSS(await hit('https://feeds.bbci.co.uk/sport/football/teams/arsenal/rss.xml'));
const art=b.find(x=>/articles\//.test(x.url))||b[0];
console.log('bbc img',!!art.image);
show('bbc '+art.url.slice(-30),pageBlocks(await hit(art.url)));
for(const [n,u] of [['tele-direct','https://www.telegraph.co.uk/football/rss.xml'],['ath-direct','https://www.nytimes.com/athletic/rss/football/'],['gn-tele','https://news.google.com/rss/search?q='+encodeURIComponent('arsenal site:telegraph.co.uk/football when:14d')+'&hl=en-GB&gl=GB&ceid=GB:en'],['gn-ath','https://news.google.com/rss/search?q='+encodeURIComponent('arsenal site:nytimes.com/athletic when:14d')+'&hl=en-GB&gl=GB&ceid=GB:en']]){
 try{const r=parseRSS(await hit(u));console.log(n,r.length,r.slice(0,4).map(x=>x.title.slice(0,50)+(x.image?' [img]':'')))}catch(e){console.log(n,e.message)}
}
const a=parseRSS(await hit('https://arseblog.com/feed'));
console.log('arseblog.com',a.length,a[0]?.pid,a[0]?.comments,!!a[0]?.content);
