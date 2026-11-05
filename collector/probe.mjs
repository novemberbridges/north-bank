// Temporary diagnostics. Prints status codes and response shape only.
const K=process.env.GUARDIAN_KEY||'test', UA={'User-Agent':'NorthBankReader/1.0 (personal news reader)'};
const hit=async(u,h={})=>{try{const r=await fetch(u,{headers:{...UA,...h},redirect:'follow',signal:AbortSignal.timeout(20000)});const t=await r.text();return{s:r.status,t}}catch(e){return{s:'ERR '+e.message,t:''}}};
const c=await hit(`https://content.guardianapis.com/search?tag=football/arsenal,-football/womensfootball&page-size=8&show-fields=shortUrl,commentable,commentCloseDate&api-key=${K}`);
const rs=JSON.parse(c.t).response.results;
const counts=rs.map(r=>/\/p\/[a-z0-9]+/i.exec(r.fields.shortUrl)?.[0]).join(',');
const cc=await hit(`https://discussion.theguardian.com/discussion-api/getCommentCounts?short-urls=${counts}`);
console.log('counts',cc.s,cc.t.slice(0,300));
for(const r of rs){
  const p=/\/p\/[a-z0-9]+/i.exec(r.fields.shortUrl)?.[0];
  console.log(p,r.fields.shortUrl,'commentable',r.fields.commentable,'close',r.fields.commentCloseDate);
}
const r=rs.find(x=>x.fields.commentable==='true')||rs[0];
const p=/\/p\/[a-z0-9]+/i.exec(r.fields.shortUrl)[0];
const base='https://discussion.theguardian.com/discussion-api/discussion/';
for(const u of [
 `${base}${p}?api-key=dotcom-rendering&orderBy=newest&pageSize=100&page=1&displayThreads=true&maxResponses=20`,
 `${base}${p}?api-key=dotcom-rendering&orderBy=newest&page=1&pageSize=20`,
 `${base}${p}`,
 `${base}${p.slice(1)}?api-key=dotcom-rendering`,
 `${base}${p}/topcomments`,
 `https://discussion.theguardian.com/discussion-api/discussion/${encodeURIComponent(p)}?api-key=dotcom-rendering`,
]){
 const x=await hit(u,{Origin:'https://www.theguardian.com',Referer:'https://www.theguardian.com/'});
 console.log(x.s,u.replace(base,'BASE/'),x.s===200?Object.keys(JSON.parse(x.t)):x.t.slice(0,160));
}
const page=await hit(r.webUrl);
console.log('page',page.s,(page.t.match(/"(?:shortUrlId|shortUrl|discussionApiUrl|commentable|isCommentable|discussionApiClientHeader)":[^,]{0,90}/g)||[]).slice(0,10));
// Arseblog
const a=await hit('https://arseblog.news/feed/');
const guid=/<guid[^>]*>([^<]+)/.exec(a.t)?.[1], cnt=/slash:comments>(\d+)/.exec(a.t)?.[1];
console.log('arseblog feed',a.s,guid,'count',cnt,'hasContent',/content:encoded/.test(a.t));
const pid=/[?&]p=(\d+)/.exec(guid||'')?.[1];
const w=await hit(`https://arseblog.news/wp-json/wp/v2/comments?post=${pid}&per_page=5`);
console.log('wp rest',w.s,w.t.slice(0,120).replace(/[^\x20-\x7e]/g,''));
const link=/<item>[\s\S]*?<link>([^<]+)/.exec(a.t)?.[1];
const ap=await hit(link);
console.log('arseblog page',ap.s,'wpd-comm ids',(ap.t.match(/id=["']wpd-comm-/g)||[]).length,'comment-text',(ap.t.match(/wpd-comment-text/g)||[]).length,'author',(ap.t.match(/wpd-comment-author/g)||[]).length,'vote',(ap.t.match(/wpd-vote-result/g)||[]).length);
const m=/<div[^>]*id=["']wpd-comm-[^>]*>/.exec(ap.t); console.log(m?.[0]?.slice(0,160));
// BBC comment hint
