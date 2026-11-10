import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app,BrowserWindow,session } from 'electron';
import { acceptUserscriptGhostWorkers } from './lib/userscript-ghost-workers-acceptance.mjs';

const repositoryRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const resultsRoot=path.join(repositoryRoot,'test-results','instagram-sandbox');
const userData=path.join(resultsRoot,'profiles',String(process.pid));
await mkdir(userData,{recursive:true});
app.disableHardwareAcceleration();app.setPath('userData',userData);app.on('window-all-closed',()=>{});
const releaseVersion=JSON.parse(await readFile(path.join(repositoryRoot,'package.json'),'utf8')).version;
const bundle=await readFile(path.join(repositoryRoot,'userscripts','insta-toolbox.user.js'));
const bundleSha256=createHash('sha256').update(bundle).digest('hex');
const interactive=process.env.INSTA_TOOLBOX_SANDBOX_INTERACTIVE==='1';
const ROOT=`document.querySelector('#insta-toolbox-userscript-root').shadowRoot`;
const checks=[],failures=[],network=[],problems=[],evidence=[];
const runIdentity=new Date().toISOString().replaceAll(':','-');
let window,isolated;
let announcementMetrics=null;
const withTimeout=(promise,label,timeoutMs=30_000)=>{
  let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} timed out`)),timeoutMs);})]).finally(()=>clearTimeout(timer));
};
async function waitForPageValue(web,expression,label,timeoutMs=15_000){
  const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){const value=await web.executeJavaScript(expression,true);if(value)return value;await new Promise(resolve=>setTimeout(resolve,75));}
  const state=await web.executeJavaScript(`({route:location.pathname,toolbox:document.querySelector('#insta-toolbox-userscript-root')?.shadowRoot?.querySelector('.panel')?.innerText?.slice(0,8000),state:globalThis.instagramSandbox?.snapshot()})`,true);
  throw new Error(`${label} timed out: ${JSON.stringify(state)}`);
}
const evaluate=expression=>window.webContents.executeJavaScript(expression,true);
const value=selector=>`${ROOT}.querySelector(${JSON.stringify(selector)})`;
async function click(selector){
  await evaluate(`(()=>{const node=${value(selector)};if(!node||node.disabled||node.hidden)throw new Error('Unavailable control: '+${JSON.stringify(selector)});node.scrollIntoView({block:'center'});return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));})()`);
  const point=await evaluate(`(()=>{const node=${value(selector)},r=node.getBoundingClientRect();if(r.width<=0||r.height<=0)throw new Error('Hidden control: '+${JSON.stringify(selector)});return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
  window.webContents.focus();for(const type of ['mouseMove','mouseDown','mouseUp'])window.webContents.sendInputEvent({type,...point,...(type==='mouseMove'?{}:{button:'left',clickCount:1})});
}
async function change(selector,newValue){
  await evaluate(`(()=>{const node=${value(selector)};node.value=${JSON.stringify(String(newValue))};node.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function openView(view){
  await evaluate(`(()=>{const root=${ROOT};if(root.querySelector('.panel').hidden)root.querySelector('.launcher').click();root.querySelector('[data-view="${view}"]').click();})()`);
}
async function screenshot(name){
  const web=window.webContents;
  await withTimeout(web.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',true),`${name}: animation frames`,5000);
  await withTimeout(new Promise(resolve=>{web.once('paint',resolve);web.invalidate();}),`${name}: fresh paint`,5000);
  const captured=await withTimeout(window.capturePage(),`${name}: screenshot`,10000);
  assert.equal(captured.isEmpty(),false,`${name}: screenshot is empty`);
  await writeFile(path.join(resultsRoot,`${name}.png`),captured.toPNG());
}
async function check(name,run){
  try{await run();checks.push(name);evidence.push({name,state:await snapshot()});console.log(`PASS ${name}`);}catch(error){
    const failure={name,error:error.stack||String(error)};failures.push(failure);
    try{await screenshot(`failed-${runIdentity}-${failures.length}`);}catch(captureError){failure.captureError=captureError.stack||String(captureError);}
    throw error;
  }
}
async function ready(){
  await withTimeout(window.loadURL('https://www.instagram.com/sandbox/'),'sandbox load');
  await waitForPageValue(window.webContents,`Boolean(document.querySelector('#insta-toolbox-userscript-root')?.shadowRoot?.querySelector('[data-presence-start]'))`,'generated userscript mount');
  await openView('checker');
}
async function scan(type){
  await evaluate(`instagramSandbox.openList(${JSON.stringify(type)});${value('[data-action="scan-following"]')}.closest('details').open=true;`);
  await click(`[data-action="scan-${type}"]`);
  await waitForPageValue(window.webContents,`instagramSandbox.managerTab().instaToolboxCheckerDraftV1?.capture?.complete?.${type}===true`,`complete ${type} virtualized scan`,25_000);
}
async function selectPresence(actions,maxActions=1,mode='session'){
  await openView('account');
  await evaluate(`(()=>{for(const input of ${ROOT}.querySelectorAll('[data-presence-action]')){input.checked=${JSON.stringify(actions)}.includes(input.dataset.presenceAction);input.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
  await change('[data-presence-mode]',mode);await change('[data-presence-limit]',maxActions);
}
async function startPresence({cancel=false}={}){
  await click('[data-presence-start]');
  await waitForPageValue(window.webContents,`${value('[data-role="action-confirmation"]')}.open`,'Presence review');
  await click(cancel?'[data-action="confirm-cancel"]':'[data-action="confirm-accept"]');
  await waitForPageValue(window.webContents,`!${value('[data-role="action-confirmation"]')}.open`,'Presence review settlement');
}
async function presenceFinished(){
  await waitForPageValue(window.webContents,`${value('.presence-status strong')}.textContent==='Presence finished'`,'Presence completion',35_000);
}
const snapshot=()=>evaluate('instagramSandbox.snapshot()');
async function run(){
  let exitCode=0;
  isolated=session.fromPartition(`insta-toolbox-native-sandbox-${process.pid}`);
  isolated.setPermissionCheckHandler(()=>false);isolated.setPermissionRequestHandler((_,__,callback)=>callback(false));
  const assets=new Map([
    ['/sandbox/',path.join(repositoryRoot,'tests','fixtures','instagram-sandbox.html')],
    ['/sandbox/instagram-sandbox.js',path.join(repositoryRoot,'tests','fixtures','instagram-sandbox.js')],
    ['/userscripts/insta-toolbox.user.js',path.join(repositoryRoot,'userscripts','insta-toolbox.user.js')],
  ]);
  await isolated.protocol.handle('http',request=>{network.push({url:request.url,allowed:false});return new Response('',{status:403});});
  await isolated.protocol.handle('https',async request=>{
    const url=new URL(request.url);
    const page=/^\/(?:[\w.]+|direct\/inbox|direct\/t\/\d+)\/$/.test(url.pathname)||url.pathname==='/';
    const target=url.origin==='https://www.instagram.com'?(assets.get(url.pathname)||(page?assets.get('/sandbox/'):null)):null;
    network.push({path:url.origin==='https://www.instagram.com'?url.pathname:url.origin,allowed:Boolean(target)});
    if(!target)return new Response('Sandbox has no network service',{status:403});
    return new Response(url.pathname==='/userscripts/insta-toolbox.user.js'?bundle:await readFile(target),{headers:{'Content-Type':target.endsWith('.html')?'text/html':'text/javascript','Content-Security-Policy':"default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"}});
  });
  window=new BrowserWindow({show:interactive,width:1280,height:900,webPreferences:{session:isolated,contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false,offscreen:!interactive}});
  window.webContents.on('console-message',event=>{if(event.level==='error'||Number(event.level)>=3)problems.push(event.message);});
  window.webContents.on('render-process-gone',(_,details)=>problems.push(`renderer:${details.reason}`));
  try{
    await ready();
    if(interactive){
      console.log('Interactive synthetic Instagram sandbox. Close its window to finish. All network services are blocked.');
      await new Promise(resolve=>window.once('closed',resolve));return;
    }
    await check('one generated userscript instance; controls do not mutate Instagram before review',async()=>{
      assert.equal(await evaluate(`document.querySelectorAll('#insta-toolbox-userscript-root').length`),1);
      assert.equal(await evaluate(`[...document.querySelectorAll('main header [data-sandbox-counter]')].every(node=>node.getAttribute('href')===location.pathname)`),true,'profile counters model the currently observed same-profile links');
      assert.equal(await evaluate(`[...document.querySelectorAll('[data-sandbox-profile-grid] a')].every(node=>node.querySelector('img')&&node.getAttribute('href').startsWith(location.pathname+'p/'))`),true,'profile tiles use the observed profile-prefixed post paths');
      assert.equal((await snapshot()).actions.length,0);
      assert.equal(await evaluate(`${value('[data-action="run-unsend"]')}.disabled`),true);
      await evaluate(`(()=>{const script=document.createElement('script');script.src='/userscripts/insta-toolbox.user.js';document.body.append(script);})()`);
      await new Promise(resolve=>setTimeout(resolve,100));
      assert.equal(await evaluate(`document.querySelectorAll('#insta-toolbox-userscript-root').length`),1);
      await screenshot('01-profile');
    });
    await check('Mutual Checker harvests recycled list windows and compares independent full inventories',async()=>{
      await scan('following');await scan('followers');
      const truth=await snapshot(),capture=await evaluate('instagramSandbox.managerTab().instaToolboxCheckerDraftV1.capture');
      assert.deepEqual(capture.followers.map(item=>item.username).sort(),[...truth.followers].sort());
      assert.deepEqual(capture.following.map(item=>item.username).sort(),[...truth.following].sort());
      assert.ok(truth.listWindows.some(item=>item.first>=7),'the scan must traverse a recycled row window');
      for(const [category,expected]of [
        ['mutuals',truth.following.filter(username=>truth.followers.includes(username))],
        ['not-following-me-back',truth.following.filter(username=>!truth.followers.includes(username))],
        ['i-do-not-follow-back',truth.followers.filter(username=>!truth.following.includes(username))],
      ]){
        await change('[data-role="comparison-category"]',category);
        const actual=await evaluate(`[...${ROOT}.querySelectorAll('[data-role="comparison-list"] strong')].map(node=>node.textContent.replace(/^@/,''))`);
        assert.deepEqual(actual.sort(),expected.sort(),category);
      }
      assert.equal((await snapshot()).actions.length,0,'scans are read-only');
      await evaluate(`document.querySelector('[data-sandbox-modal]')?.remove()`);await screenshot('02-mutuals');
    });
    await check('Insights reports only the independently loaded posts and downloads explicit sample coverage',async()=>{
      const before=network.length;
      await evaluate(`(()=>{const insights=${value('[data-role="loaded-insights"]')};insights.querySelector('details').open=true;[...insights.querySelectorAll('button')].find(node=>node.textContent==='Read loaded posts').click();[...insights.querySelectorAll('button')].find(node=>node.textContent==='Download JSON').click();})()`);
      const report=JSON.parse((await evaluate('instagramSandbox.download(0)')).text);
      assert.equal(report.coverage,'loaded-posts-only');assert.equal(report.posts.length,4);assert.equal(report.profile.username,'sandbox.owner');
      assert.deepEqual(report.posts.map(item=>item.id).sort(),(await snapshot()).posts.slice(0,4).map(item=>item.id).sort());
      assert.equal(network.length,before,'Insights must not request extra post data');await screenshot('03-insights');
    });
    await check('a truncated virtual list stays incomplete instead of claiming that missing accounts are non-mutuals',async()=>{
      await evaluate(`${value('[data-action="clear-capture"]')}.closest('details').open=true`);await click('[data-action="clear-capture"]');
      await evaluate(`instagramSandbox.faults({partialList:true});instagramSandbox.openList('following')`);await click('[data-action="scan-following"]');
      await waitForPageValue(window.webContents,`(()=>{const capture=instagramSandbox.managerTab().instaToolboxCheckerDraftV1?.capture;return capture?.following?.length===9&&capture.complete?.following===false;})()`,'independent partial inventory',25_000);
      assert.equal(await evaluate(`instagramSandbox.managerTab().instaToolboxCheckerDraftV1.capture.verified.following`),true);
      assert.match(await evaluate(`${value('[data-role="scan-detail"]')}.textContent`),/incomplete/i);
      await evaluate(`instagramSandbox.faults({partialList:false})`);await scan('followers');
      const summary=await evaluate(`${value('[data-role="comparison"]')}.textContent`);
      assert.match(summary,/Partial comparison/i);assert.match(summary,/missing from a list may still be a mutual/i);
      await screenshot('03-partial-list');await evaluate(`document.querySelector('[data-sandbox-modal]').remove()`);
    });
    await check('Settings persist through a real reload without restoring action authority',async()=>{
      await click('[data-action="open-settings"]');await change('[data-preference="theme"]','dark');await change('[data-preference="density"]','compact');
      await click('[data-action="close-settings"]');await ready();
      assert.equal(await evaluate('instagramSandbox.preferences().theme'),'dark');assert.equal(await evaluate('instagramSandbox.preferences().density'),'compact');
      assert.equal((await snapshot()).actions.length,0);assert.equal(await evaluate(`${ROOT}.querySelectorAll('[data-live-action]').length`),0);
    });
    await check('Presence review Cancel dispatches no native action',async()=>{
      await evaluate(`instagramSandbox.navigate('/')`);await selectPresence(['likePosts'],2);
      await startPresence({cancel:true});assert.equal((await snapshot()).actions.length,0);
    });
    await check('Presence finite Like session changes exactly the reviewed number of independent posts',async()=>{
      assert.equal(await evaluate(`document.querySelector('article [data-native-control]:has(svg[aria-label="Like"])')?.tagName`),'DIV','native Like must exercise the observed DIV rolebutton with a nested SVG name');
      await startPresence();await presenceFinished();
      const truth=await snapshot();assert.equal(truth.posts.filter(post=>post.liked).length,2);
      assert.equal(truth.actions.filter(item=>item.type==='like-post').length,2);await screenshot('04-presence-finished');
    });
    await check('Live like me continues beyond five actions; Pause, Resume and Stop preserve exact outcomes',async()=>{
      await evaluate(`instagramSandbox.navigate('/')`);await selectPresence(['likePosts'],1,'live');
      await evaluate(`(()=>{globalThis.sandboxAnnouncements={};globalThis.sandboxAnnouncementObservers=[];for(const [name,selector]of [['context','[data-role="context"] [aria-live]'],['presence','.presence-status']]){const node=${ROOT}.querySelector(selector);if(!node)continue;const metric={mutations:0,unchanged:0,live:node.getAttribute('aria-live'),samples:[]};sandboxAnnouncements[name]=metric;let previous=node.textContent;const observer=new MutationObserver(records=>{const current=node.textContent;metric.mutations+=records.length;for(const record of records)if(record.type==='childList'&&record.removedNodes.length&&record.addedNodes.length&&[...record.removedNodes].map(item=>item.textContent).join('')===[...record.addedNodes].map(item=>item.textContent).join(''))metric.unchanged+=1;if(current!==previous)metric.samples.push(current);previous=current;});observer.observe(node,{subtree:true,childList:true,characterData:true});sandboxAnnouncementObservers.push(observer);}})()`);
      await startPresence();
      await waitForPageValue(window.webContents,`instagramSandbox.snapshot().posts.filter(item=>item.liked).length>=5`,'continuous activity before Pause',35_000);
      await click('.presence-controls button:nth-child(2)');
      await waitForPageValue(window.webContents,`${value('.presence-status strong')}.textContent==='Paused'`,'continuous Pause');
      const paused=(await snapshot()).actions.length;await new Promise(resolve=>setTimeout(resolve,2200));
      assert.equal((await snapshot()).actions.length,paused,'Pause must prevent the next native action');
      await click('.presence-controls button:nth-child(3)');
      await waitForPageValue(window.webContents,`instagramSandbox.snapshot().posts.filter(item=>item.liked).length===8`,'six continuous Likes after Resume',35_000);
      await click('[data-presence-stop]');
      await waitForPageValue(window.webContents,`${value('.presence-status strong')}.textContent==='Stopped'`,'continuous Stop');
      const stopped=(await snapshot()).actions.length;await new Promise(resolve=>setTimeout(resolve,1200));assert.equal((await snapshot()).actions.length,stopped);
      const likes=(await snapshot()).actions.filter(item=>item.type==='like-post');assert.equal(likes.length,8);assert.equal(new Set(likes.map(item=>item.target)).size,8);
      announcementMetrics=await evaluate(`(()=>{sandboxAnnouncementObservers.forEach(observer=>observer.disconnect());return sandboxAnnouncements;})()`);
      assert.equal(announcementMetrics.context?.live,'polite');assert.equal(announcementMetrics.presence?.live,'polite');
      assert.equal(announcementMetrics.context.unchanged,0,'unchanged context cannot repeatedly replace live-region text');
      assert.equal(announcementMetrics.presence.unchanged,0,'unchanged Presence status cannot repeatedly replace live-region text');
      assert.ok(!announcementMetrics.context.samples.some(text=>/^Presence active\s+Presence finished/i.test(text)),
        'a new active session cannot announce the previous session as finished');
      await screenshot('04-live-paused-resumed-stopped');
    });
    await check('Presence Follow and incoming-request acceptance are verified in native state',async()=>{
      await evaluate(`instagramSandbox.navigate('/')`);await selectPresence(['followPeople']);await startPresence();
      await waitForPageValue(window.webContents,`instagramSandbox.snapshot().suggestions.filter(item=>item.following).length===1`,'independent follow outcome');await presenceFinished();
      assert.equal((await snapshot()).suggestions.filter(item=>item.following).length,1);
      await evaluate(`instagramSandbox.navigate('/')`);await selectPresence(['acceptRequests']);await startPresence();
      await waitForPageValue(window.webContents,`instagramSandbox.snapshot().requests.filter(item=>item.accepted).length===1`,'independent request outcome');await presenceFinished();
      assert.equal((await snapshot()).requests.filter(item=>item.accepted).length,1);
    });
    await check('account switch between review and confirmation cannot dispatch the old account action',async()=>{
      await evaluate(`instagramSandbox.navigate('/')`);await selectPresence(['followPeople']);await click('[data-presence-start]');
      await waitForPageValue(window.webContents,`${value('[data-role="action-confirmation"]')}.open`,'account-bound review');
      const before=(await snapshot()).actions.length;await evaluate(`instagramSandbox.switchAccount('sandbox.other')`);
      if(await evaluate(`${value('[data-role="action-confirmation"]')}.open`))await click('[data-action="confirm-accept"]');
      await new Promise(resolve=>setTimeout(resolve,750));assert.equal((await snapshot()).actions.length,before);
      await evaluate(`instagramSandbox.switchAccount('sandbox.owner')`);
    });
    await check('story viewing advances three ID-less native slides without inventing unseen outcomes',async()=>{
      await evaluate(`instagramSandbox.navigate('/')`);await selectPresence(['viewStories'],3);await startPresence();
      await waitForPageValue(window.webContents,`instagramSandbox.snapshot().story===3`,'third ID-less story');await presenceFinished();
      const truth=await snapshot();assert.equal(truth.actions.filter(item=>item.type==='view-story').length,3);assert.equal(truth.storyReactions.length,0);
    });
    await check('DM Unsend newest scope removes only the independently newest sent message',async()=>{
      await evaluate(`instagramSandbox.navigate('/direct/t/501/')`);await openView('messages');
      await evaluate(`${value('[data-role="unsend-scope"]')}.closest('details').open=true`);
      await change('[data-role="unsend-scope"]','newest');await change('[data-role="unsend-count"]',1);
      await click('[data-action="run-unsend"]');await waitForPageValue(window.webContents,`${value('[data-role="action-confirmation"]')}.open`,'DM exact review');
      assert.equal((await snapshot()).actions.filter(item=>item.type==='unsend').length,0);
      await click('[data-action="confirm-accept"]');
      await waitForPageValue(window.webContents,`instagramSandbox.snapshot().messages['501'].some(item=>item.removed)`,'native newest sent removal',30_000);
      const messages=(await snapshot()).messages['501'];assert.deepEqual(messages.filter(item=>item.removed).map(item=>item.id),['sent-b']);
      assert.ok(messages.filter(item=>!item.sent).every(item=>!item.removed));await screenshot('05-dm-newest');
    });
    await check('reviewed campaign Unfollow stops before a delayed native confirmation and records no mutation',async()=>{
      await evaluate(`instagramSandbox.seedDueUnfollow('following_11')`);
      await withTimeout(window.loadURL('https://www.instagram.com/following_11/'),'campaign target profile');
      await waitForPageValue(window.webContents,`Boolean(document.querySelector('#insta-toolbox-userscript-root')?.shadowRoot?.querySelector('.presence-growth'))`,'growth campaign mount');
      await openView('account');await evaluate(`instagramSandbox.faults({delayMs:700});${value('.presence-growth')}.open=true`);
      await click('.presence-growth button:last-child');
      await waitForPageValue(window.webContents,`${value('[data-role="action-confirmation"]')}.open`,'campaign unfollow exact review');
      await click('[data-action="confirm-accept"]');
      await waitForPageValue(window.webContents,`instagramSandbox.snapshot().pendingUnfollow`,'native Following menu opening');
      await click('[data-action="stop-run"]');
      await waitForPageValue(window.webContents,`Boolean(document.querySelector('[data-sandbox-modal]'))`,'delayed native Unfollow dialog');
      await new Promise(resolve=>setTimeout(resolve,300));
      const truth=await snapshot();assert.equal(truth.actions.filter(item=>item.type==='unfollow').length,0);assert.ok(truth.following.includes('following_11'));
      assert.equal(await evaluate(`GM_getValue('instaToolboxUserscriptStateV2',{}).run`),null,'account authority cannot leak into shared GM storage');
      assert.ok(await evaluate(`instagramSandbox.managerTab().instaToolboxAccountRunV1?.status!=='running'`));await screenshot('06-unfollow-stopped');
    });
    await check('a fresh campaign review can complete one exact Unfollow and record its verified outcome',async()=>{
      await withTimeout(window.loadURL('https://www.instagram.com/following_11/'),'fresh campaign target profile');
      await waitForPageValue(window.webContents,`Boolean(document.querySelector('#insta-toolbox-userscript-root')?.shadowRoot?.querySelector('.presence-growth'))`,'fresh campaign mount');
      await openView('account');await evaluate(`${value('.presence-growth')}.open=true`);await click('.presence-growth button:last-child');
      await waitForPageValue(window.webContents,`${value('[data-role="action-confirmation"]')}.open`,'fresh Unfollow approval');await click('[data-action="confirm-accept"]');
      await waitForPageValue(window.webContents,`instagramSandbox.snapshot().actions.some(item=>item.type==='unfollow')`,'independent native Unfollow',15_000);
      const truth=await snapshot();assert.deepEqual(truth.actions.filter(item=>item.type==='unfollow').map(item=>item.target),['following_11']);
      assert.equal(truth.following.includes('following_11'),false);
      await waitForPageValue(window.webContents,`GM_getValue('instaToolboxPresenceGrowthV1:sandbox.owner',[])[0]?.unfollowed?.following_11>0`,'verified campaign Unfollow ledger');
      await screenshot('07-unfollow-verified');
    });
    assert.deepEqual(problems,[],'unexpected renderer errors');
    if(process.env.INSTA_TOOLBOX_SANDBOX_SKIP_GHOST!=='1')await check('Ghost uses actual worker tabs and independently preserves received messages in twelve threads',async()=>{
      assert.equal(createHash('sha256').update(await readFile(path.join(repositoryRoot,'userscripts','insta-toolbox.user.js'))).digest('hex'),bundleSha256,'the candidate changed during this run; rerun the final bundle');
      const fixtureAssets=new Map([
        ['/userscript-fixture.html',path.join(repositoryRoot,'tests','fixtures','userscript-preview.html')],
        ['/userscripts/insta-toolbox.user.js',path.join(repositoryRoot,'userscripts','insta-toolbox.user.js')],
      ]);
      await acceptUserscriptGhostWorkers({fixtureAssets,resultsRoot,releaseVersion,withTimeout,waitForPageValue});
    });
  }catch(error){exitCode=1;console.error(error.stack||error);}
  finally{
    const report={version:releaseVersion,bundleSha256,fixtureOnly:true,liveValidated:false,instagramSourceCopied:false,
      provenance:'Current read-only authenticated feed/profile/list/inbox DOM contracts observed 2026-11-09, plus explicitly retained/synthetic DM/story/worker behavior; not a one-to-one Instagram implementation.',
      runIdentity,mode:interactive?'interactive':'automated',ghostWorkerGateExcluded:process.env.INSTA_TOOLBOX_SANDBOX_SKIP_GHOST==='1',checks,failures,network,problems,evidence,announcementMetrics,limitations:['No authenticated Instagram backend, anti-abuse, localization, or experiments.','DOM contracts can drift independently of this fixture.','Local model outcomes do not prove real-account outcomes.'],
      finalState:!window.isDestroyed()?await snapshot().catch(()=>null):null};
    await writeFile(path.join(resultsRoot,'report.json'),`${JSON.stringify(report,null,2)}\n`);
    await mkdir(path.join(resultsRoot,'reports'),{recursive:true});
    await writeFile(path.join(resultsRoot,'reports',`${runIdentity}.json`),`${JSON.stringify(report,null,2)}\n`);
    if(!window.isDestroyed())window.destroy();await isolated.clearStorageData();
    console.log(`Instagram interaction sandbox: ${checks.length} passed, ${failures.length} failed. Evidence: ${resultsRoot}`);app.exit(exitCode);
  }
}
app.whenReady().then(run).catch(error=>{console.error(error);app.exit(1);});
