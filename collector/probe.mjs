// Temporary: prints field names only.
const r=await fetch('https://discussion.theguardian.com/discussion-api/discussion//p/x6bjyc?api-key=dotcom-rendering&orderBy=newest&pageSize=100&page=1&displayThreads=true&maxResponses=20');
const j=await r.json();const c=j.discussion.comments;
console.log('pages',j.pages,'count',j.discussion.commentCount,'top',c.length);
console.log('fields',Object.keys(c[0]).join(','));console.log('profile',Object.keys(c[0].userProfile||{}).join(','));
console.log('hasIso',!!c[0].isoDateTime,'withResponses',c.filter(x=>x.responses?.length).length,'numResp',c.reduce((n,x)=>n+(x.numResponses||0),0),'loadedResp',c.reduce((n,x)=>n+(x.responses?.length||0),0));
