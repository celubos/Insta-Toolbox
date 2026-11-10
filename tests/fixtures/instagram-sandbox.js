/* Synthetic native-UI contract fixture. It contains no Instagram source or account data.
 * Production code reads and clicks DOM; this independently owned model records outcomes.
 * See docs/INSTAGRAM_SANDBOX.md for observation provenance and fidelity limits. */
(() => {
  'use strict';
  const avatar = color => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="480"><rect width="320" height="480" fill="${color}"/></svg>`)}`;
  const account = (prefix, index) => `${prefix}_${String(index + 1).padStart(2, '0')}`;
  const followers = Array.from({length:18}, (_, index) => account(index < 10 ? 'mutual' : 'follower', index));
  const following = Array.from({length:16}, (_, index) => account(index < 10 ? 'mutual' : 'following', index));
  const state = {
    owner: 'sandbox.owner', profile: 'sandbox.owner', followers, following,
    posts: Array.from({length:8}, (_, index) => ({id:`sandbox-post-${index + 1}`, liked:false, type:index === 2 ? 'video' : index === 3 ? 'carousel' : 'unknown'})),
    suggestions: [{username:'sandbox.creator',following:false,private:false},{username:'sandbox.private',following:false,private:true}],
    requests: [{username:'sandbox.request',accepted:false}],
    threads: [{id:'501',title:'Sandbox Friend',username:'sandbox.friend'},{id:'502',title:'Sandbox Group',username:null}],
    messages: {}, actions: [], listWindows: [], faults:{delayMs:60,blockActions:false,partialList:false,loadFailure:false},
    route:'', story:0, storyReactions:[], visits:[], requestsMade:[], pendingUnfollow:false,
  };
  for (const thread of state.threads) state.messages[thread.id] = [
    {id:'received-a',sent:false,text:'Synthetic received message remains.',removed:false},
    {id:'sent-a',sent:true,text:'Synthetic older sent message.',removed:false},
    {id:'received-b',sent:false,text:'Synthetic second received message remains.',removed:false},
    {id:'sent-b',sent:true,text:'Synthetic newest sent message.',removed:false},
    {id:'received-c',sent:false,text:'Synthetic final received message remains.',removed:false},
  ];
  const read = (key, fallback) => {
    try { const value=localStorage.getItem(key);return value === null ? fallback : JSON.parse(value); }
    catch { return fallback; }
  };
  const storeKey='sandbox:gm:';
  globalThis.GM_getValue=(key,fallback)=>structuredClone(read(storeKey+key,fallback));
  globalThis.GM_setValue=(key,value)=>localStorage.setItem(storeKey+key,JSON.stringify(value));
  globalThis.GM_getTab=callback=>callback(structuredClone(read('sandbox:manager-tab',{})));
  globalThis.GM_saveTab=value=>localStorage.setItem('sandbox:manager-tab',JSON.stringify(value));
  globalThis.GM_info={script:{name:'Insta Toolbox sandbox',version:'fixture'}};
  const downloads=[];
  const nativeAnchorClick=HTMLAnchorElement.prototype.click;
  const objectUrls=new Map(),createObjectURL=URL.createObjectURL.bind(URL);
  URL.createObjectURL=blob=>{const url=createObjectURL(blob);objectUrls.set(url,blob);return url;};
  HTMLAnchorElement.prototype.click=function(){
    const blob=objectUrls.get(this.href);
    if(this.download&&blob){downloads.push({filename:this.download,blob});return;}
    return nativeAnchorClick.call(this);
  };
  const main=document.querySelector('main'),nav=document.querySelector('nav');
  const element=(tag,text,attributes={})=>{
    const node=document.createElement(tag);if(text!==null)node.textContent=text;
    for(const [name,value]of Object.entries(attributes))node.setAttribute(name,value);
    return node;
  };
  const link=(href,text)=>element('a',text,{href,role:'link'});
  const button=(name,handler)=>{
    const node=element('button',name,{type:'button','aria-label':name});
    node.addEventListener('click',handler);return node;
  };
  const nativeButton=(name,handler,{ownLabel=false}={})=>{
    const node=element('div','',{role:'button',tabindex:'0','data-native-control':''});
    if(ownLabel)node.setAttribute('aria-label',name);
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('aria-label',name);svg.setAttribute('role','img');svg.setAttribute('viewBox','0 0 24 24');
    const title=document.createElementNS('http://www.w3.org/2000/svg','title');title.textContent=name;
    const shape=document.createElementNS('http://www.w3.org/2000/svg','circle');shape.setAttribute('cx','12');shape.setAttribute('cy','12');shape.setAttribute('r','8');
    svg.append(title,shape);node.append(svg);node.addEventListener('click',handler);
    node.addEventListener('keydown',event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();node.click();}});return node;
  };
  const nativeName=(node,name)=>{
    const svg=node.querySelector('svg');if(svg){svg.setAttribute('aria-label',name);svg.querySelector('title').textContent=name;}
    else{node.textContent=name;node.setAttribute('aria-label',name);}
  };
  const action=(type,target,apply)=>{
    if(state.faults.blockActions){showError('Try again later. We restrict certain activity to protect our community.');return;}
    state.actions.push({type,target,at:state.actions.length+1});apply();
  };
  const showError=text=>{
    const existing=document.querySelector('[data-sandbox-error]');existing?.remove();
    main.prepend(element('div',text,{'data-sandbox-error':'','role':'alert'}));
  };
  const setRoute=path=>{history.replaceState({},'',path);state.route=path;globalThis.scrollTo(0,0);};
  const clear=()=>{document.querySelectorAll('[data-sandbox-modal]').forEach(n=>n.remove());main.replaceChildren();};
  const note=()=>main.append(element('aside','Synthetic interaction sandbox. No real account or network changes.',{'data-sandbox-note':''}));
  function navigation(){
    nav.replaceChildren(element('strong','Instagram · sandbox'));
    for(const [href,label]of [['/','Home'],['/explore/','Explore'],['/reels/','Reels'],['/direct/inbox/','Messages']]){
      const node=link(href,label);node.setAttribute('role','link');node.addEventListener('click',event=>{event.preventDefault();route(href);});nav.append(node);
    }
    const profile=link(`/${state.owner}/`,'');profile.setAttribute('role','link');
    profile.append(element('img',null,{width:'28',height:'28',alt:`${state.owner}'s profile picture`,src:avatar('#478d89')}),element('span',state.owner));
    profile.addEventListener('click',event=>{event.preventDefault();route(`/${state.owner}/`);});nav.append(profile);
  }
  function postView(post){
    const article=element('article','');article.append(link('/sandbox.creator/','sandbox.creator'),nativeButton('More options',()=>{}));
    if(post.type==='video')article.append(element('video',null,{'aria-label':'Synthetic video',class:'media'}));
    else article.append(element('img',null,{alt:'Synthetic landscape',class:'media',src:avatar(post.type==='carousel'?'#a6c9ac':'#ced6cc')}));
    if(post.type==='carousel')article.append(element('div','2 of 3',{'aria-label':'Slide 2 of 3'}));
    const timestamp=link(`/p/${post.id}/`,'');timestamp.append(element('time','November 2',{datetime:'2026-11-02T12:00:00Z'}));
    article.append(timestamp,link('/explore/tags/sandbox/','#sandbox'));
    const actions=element('section','',{'data-sandbox-post-actions':''});
    const like=nativeButton(post.liked?'Unlike':'Like',()=>action('like-post',post.id,()=>{
      post.liked=!post.liked;nativeName(like,post.liked?'Unlike':'Like');
    }));
    for(const control of [like,...['Comment','Repost','Share','Save'].map(name=>nativeButton(name,()=>{}))]){
      const wrapper=element('span','');wrapper.append(control);actions.append(wrapper);
    }
    article.append(actions,element('p','Synthetic caption'));return article;
  }
  function suggestions(){
    const wrapper=element('div','',{'data-sandbox-suggestions':''});
    for(const item of state.suggestions){
      const card=element('section','');if(item.private)card.setAttribute('data-private-profile','');
      const control=button(item.following?(item.private?'Requested':'Following'):'Follow',()=>action('follow',item.username,()=>{
        item.following=true;control.textContent=item.private?'Requested':'Following';control.setAttribute('aria-label',control.textContent);
      }));card.append(link(`/${item.username}/`,item.username),control);wrapper.append(card);
    }
    for(const request of state.requests){
      const card=element('section','');const confirm=button(request.accepted?'Following':'Confirm',()=>action('accept-request',request.username,()=>{
        request.accepted=true;confirm.textContent='Following';confirm.setAttribute('aria-label','Following');
      }));card.append(link(`/${request.username}/`,request.username),confirm);wrapper.append(card);
    }
    main.append(wrapper);
  }
  function home(path='/'){
    clear();setRoute(path);note();
    const stories=element('section','');
    const storyTile=nativeButton('Story by sandbox.friend, not seen',event=>{event.preventDefault();story(1);},{ownLabel:true});
    storyTile.setAttribute('data-sandbox-story-tray','');
    const storyProfile=link('/sandbox.friend/','');storyProfile.append(element('img',null,{src:avatar('#a5bdb0'),width:'44',height:'44',alt:'Synthetic story profile'}));
    storyTile.replaceChildren(storyProfile,element('span','sandbox.friend'));stories.append(storyTile);main.append(stories);
    suggestions();for(const post of state.posts)main.append(postView(post));
  }
  function profile(username=state.owner){
    clear();setRoute(`/${username}/`);state.profile=username;note();
    const header=element('header','');header.append(element('h1',username));
    for(const type of ['followers','following']){
      const node=link(`/${username}/`,`${state[type].length} ${type}`);node.setAttribute('data-sandbox-counter',type);
      node.addEventListener('click',event=>{event.preventDefault();openList(type);});header.append(node);
    }
    if(username!==state.owner){
      const known=state.suggestions.find(item=>item.username===username);
      const isFollowing=()=>state.following.includes(username)||known?.following;
      const control=button(isFollowing()?'Following':'Follow',()=>{
        if(!isFollowing())return action('follow',username,()=>{
          if(known)known.following=true;if(!state.following.includes(username))state.following.push(username);
          control.textContent='Following';control.setAttribute('aria-label','Following');
        });
        state.pendingUnfollow=true;
        setTimeout(()=>{
          const dialog=element('div','',{'role':'dialog','data-sandbox-modal':''});
          dialog.append(element('p',`Unfollow @${username}?`),button('Cancel',()=>{state.pendingUnfollow=false;dialog.remove();}),button('Unfollow',()=>action('unfollow',username,()=>{
            state.following=state.following.filter(value=>value!==username);if(known)known.following=false;
            state.pendingUnfollow=false;dialog.remove();control.textContent='Follow';control.setAttribute('aria-label','Follow');
          })));document.body.append(dialog);
        },state.faults.delayMs);
      });header.append(control,button('View story',()=>story(1)));
    }
    const grid=element('div','',{'data-sandbox-profile-grid':''});
    for(const post of state.posts.slice(0,4)){
      const tile=link(`/${username}/p/${post.id}/`,'');tile.append(element('img',null,{src:avatar('#91a9a1'),alt:'Synthetic profile post',width:'240',height:'200'}));grid.append(tile);
    }
    main.append(header,grid);
  }
  function openList(type){
    document.querySelectorAll('[data-sandbox-modal]').forEach(node=>node.remove());
    const dialog=element('div','',{'role':'dialog','aria-label':type==='followers'?'Followers':'Following','data-sandbox-modal':''});
    dialog.append(element('span',type==='followers'?'Followers':'Following'),button('Close',()=>dialog.remove()));
    const scroller=element('div','',{'data-sandbox-list':''}),spacer=element('div',''),window=element('div','',{'data-sandbox-window':''});
    scroller.style.overflowY='scroll';
    const values=state.faults.partialList?state[type].slice(0,9):state[type];
    spacer.style.height=`${values.length*44}px`;scroller.append(spacer,window);dialog.append(scroller);document.body.append(dialog);
    const paint=()=>{
      const first=Math.max(0,Math.min(values.length-1,Math.floor(scroller.scrollTop/44)));
      window.style.top=`${first*44}px`;window.replaceChildren();state.listWindows.push({type,first});
      for(const username of values.slice(first,first+7)){
        const row=element('div','');row.style.cssText='display:flex;align-items:center;gap:8px;height:44px';
        const imageLink=link(`/${username}/`,'');imageLink.append(element('img',null,{src:avatar('#b2cfbf'),alt:`${username}'s profile picture`,width:'28',height:'28'}));
        const nameLink=link(`/${username}/`,username);
        const control=type==='followers'?nativeButton('Remove',()=>{}):button('Follow',()=>{});
        row.append(imageLink,nameLink,control);
        window.append(row);
      }
    };
    scroller.addEventListener('scroll',()=>setTimeout(paint,state.faults.delayMs));paint();
    if(state.faults.loadFailure)showError("Couldn't refresh feed");
  }
  function story(slide){
    clear();setRoute('/stories/sandbox.friend/');state.story=slide;
    const viewer=element('section','',{'data-sandbox-story':''});
    viewer.append(element('img',null,{src:avatar(['#c6d5c6','#c0cbd8','#e1c6c0'][slide-1]),alt:'Story',width:'270',height:'400'}));
    viewer.append(button('Pause',()=>{}));
    const like=button(state.storyReactions.includes(slide)?'Unlike':'Like',()=>action('react-story',String(slide),()=>{
      state.storyReactions.push(slide);like.textContent='Unlike';like.setAttribute('aria-label','Unlike');
    }));viewer.append(like);
    if(slide<3)viewer.append(button('Next',()=>story(slide+1)));
    viewer.append(button('Close',()=>home()));main.append(viewer);state.actions.push({type:'view-story',target:String(slide),at:state.actions.length+1});
  }
  function message(list,thread,item){
    const timestamp=element('div','Synthetic timestamp');timestamp.style.cssText='height:22px;font-size:12px';
    const slot=element('div',''),wrapper=element('div',''),group=element('div','',{role:'group'}),column=element('div',''),lane=element('div',''),payload=element('div','');
    column.style.cssText='display:flex;flex-direction:column;justify-content:flex-start';
    lane.style.cssText=`display:flex;flex-direction:row;justify-content:${item.sent?'flex-end':'flex-start'}`;
    const spacer=element('div','',{'aria-hidden':'true'});payload.style.cssText=`display:flex;flex-direction:${item.sent?'row-reverse':'row'};justify-content:flex-start`;
    const body=element('div',item.text,{dir:'auto'}),actions=element('div','',{role:'group','aria-label':'Message actions'});
    const more=element('div','More',{role:'button',tabindex:'0','aria-label':`See more options for message from ${item.sent?state.owner:'sandbox.friend'}`});
    actions.append(more);payload.append(body,actions);lane.append(spacer,payload);column.append(lane);group.append(column);wrapper.append(group);slot.append(wrapper);list.append(timestamp,slot);
    more.addEventListener('click',()=>{
      if(!item.sent)return;
      setTimeout(()=>{
        const menu=element('div','',{role:'menu','data-sandbox-modal':''});
        menu.append(button('Unsend',()=>{
          menu.remove();const dialog=element('div','',{role:'dialog','data-sandbox-modal':''});
          dialog.append(element('p','Unsend message?'),button('Cancel',()=>dialog.remove()),button('Unsend',()=>action('unsend',`${thread.id}:${item.id}`,()=>{
            if(item.removed)throw new Error('Duplicate sandbox removal');item.removed=true;dialog.remove();slot.remove();timestamp.remove();
          })));document.body.append(dialog);
        }));document.body.append(menu);
      },state.faults.delayMs);
    });
  }
  function inbox(selected=null){
    clear();setRoute('/direct/inbox/');note();
    const rail=element('div','',{'aria-label':'Thread list',role:'navigation'}),picker=element('div','',{role:'button',tabindex:'0'});picker.append(element('h2',state.owner));rail.append(picker);
    rail.style.overflowY='visible';
    const noteRow=element('ul',''),noteItem=element('li',''),noteButton=element('div','Your note',{role:'button',tabindex:'0'});noteButton.prepend(element('img',null,{src:avatar('#b2cfbf'),width:'24',height:'24',alt:'Synthetic note profile'}));noteItem.append(noteButton);noteRow.append(noteItem);rail.append(noteRow);
    rail.append(element('div','Primary',{role:'tab','aria-selected':'true'}));
    const threadScroll=element('div','');threadScroll.style.cssText='height:260px;overflow-y:auto';rail.append(threadScroll);main.append(rail);
    for(const thread of state.threads){
      const row=element('div','',{role:'button',tabindex:'0','data-sandbox-thread':thread.id});
      row.append(element('img',null,{width:'28',height:'28',src:avatar('#91b3bb'),alt:thread.title}),element('span',`Preview of ${thread.title}`),element('span','Synthetic timestamp'));
      row.addEventListener('click',()=>{
        main.querySelector('[data-sandbox-chat]')?.remove();
        for(const sibling of rail.querySelectorAll('[data-sandbox-thread]'))sibling.setAttribute('aria-pressed',String(sibling===row));
        setRoute(`/direct/t/${thread.id}/`);state.visits.push(thread.id);
        const chat=element('section','',{'data-sandbox-chat':''}),header=element('div','',{'data-pagelet':'IGDInboxHeaderOffMsys'}),heading=element('h2',thread.title);
        if(thread.username){const profile=link(`/${thread.username}/`,'');profile.setAttribute('role','link');profile.append(heading);header.append(profile);}else header.append(heading);
        const pane=element('div','',{'data-pagelet':'IGDMessagesList'}),scroller=element('div',''),list=element('div','');
        scroller.style.cssText='height:360px;overflow-y:scroll;display:flex;flex-direction:column-reverse';list.style.flex='none';
        for(const item of state.messages[thread.id])if(!item.removed)message(list,thread,item);
        scroller.append(list);pane.append(scroller);chat.append(header,pane,element('div','Synthetic message composer',{'data-pagelet':'IGDComposerForCannes'}));main.append(chat);
      });threadScroll.append(row);
    }
    if(selected)rail.querySelector(`[data-sandbox-thread="${selected}"]`)?.click();
  }
  function route(path){
    if(path==='/direct/inbox/')return inbox();
    const thread=path.match(/^\/direct\/t\/(\d+)\/$/);if(thread)return inbox(thread[1]);
    const profileMatch=path.match(/^\/([\w.]+)\/$/);if(profileMatch&&!['explore','reels'].includes(profileMatch[1]))return profile(profileMatch[1]);
    return home(path);
  }
  document.addEventListener('click',event=>{
    const anchor=event.target.closest?.('a[href]');if(event.defaultPrevented||!anchor||anchor.download||anchor.href.startsWith('blob:'))return;
    const url=new URL(anchor.href);if(url.origin!==location.origin)return;
    if(anchor.closest('nav')||/\/(?:followers|following)\/$/.test(url.pathname))return;
    if(/^\/[\w.]+\/$/.test(url.pathname)&&!url.pathname.startsWith('/p/')){event.preventDefault();route(url.pathname);}
  });
  globalThis.instagramSandbox=Object.freeze({
    snapshot:()=>structuredClone({...state,downloads:downloads.map(item=>({filename:item.filename}))}),
    navigate:route,openList,
    faults:value=>Object.assign(state.faults,value),
    switchAccount:username=>{state.owner=username;navigation();route('/');},
    download:async index=>({filename:downloads[index].filename,text:await downloads[index].blob.text()}),
    managerTab:()=>read('sandbox:manager-tab',{}),
    preferences:()=>GM_getValue('instaToolboxUserscriptPreferencesV1',null),
    resetStorage:()=>localStorage.clear(),
    seedDueUnfollow:username=>{
      const verifiedAt=Date.now()-8*24*60*60*1000;
      GM_setValue(`instaToolboxPresenceGrowthV1:${state.owner}`,[{schemaVersion:1,id:'sandbox-due-campaign',account:state.owner,createdAt:verifiedAt,delayDays:7,targets:[username],followed:{[username]:verifiedAt},unfollowed:{}}]);
    },
  });
  navigation();location.pathname==='/sandbox/'?profile():route(location.pathname);
})();
