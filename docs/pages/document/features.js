import { mountDocumentNavigation } from './navigation.js';

const values=['core','important','general','fold'], names=['Core','Important','General','Fold'];
const esc=value=>String(value).replace(/[&<>"']/gu,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const icon=(v,open=true)=>`/Cloudig/pages/document/assets/InfoValue-${names[values.indexOf(v)]}${open?'':'-Grey'}.svg`;
async function load(language) {const r=await fetch(`/Cloudig/pages/document/content/features-${language}.json`);if(!r.ok)throw new Error('Feature guide unavailable');return r.json();}
// Do not offer a button for pixel rounding or an imperceptible size change.
const MIN_ZOOM_GAIN = 1.12, MIN_ZOOM_DELTA_PX = 24;
export function screenshotNeedsZoom(naturalWidth,naturalHeight,width,height) {
  if(Math.min(naturalWidth,naturalHeight,width,height)<=0)return false;
  const gain=Math.max(naturalWidth/width,naturalHeight/height);
  return gain>=MIN_ZOOM_GAIN&&Math.max(naturalWidth-width,naturalHeight-height)>=MIN_ZOOM_DELTA_PX;
}
export async function mountFeatureDocument({page,language,onClose,onDocument,onExternal}) {
  const center=page.querySelector('.reader-main,.archiver-center');if(!center)throw new Error('Feature guide needs a central reading surface');
  const publications=Object.fromEntries(await Promise.all(['zh-CN','en'].map(async l=>[l,await load(l)])));
  const element=document.createElement('section');element.className='standard-document feature-document';
  let lang=language,navigation,zoomObserver,zoomFrame=0,disposed=false;const folded=new Set();
  const view=element.ownerDocument.defaultView;
  const scroll=()=>element.querySelector('.standard-scroll');
  function refreshZoom(){
    if(disposed||!element.isConnected)return;
    for(const figure of element.querySelectorAll('[data-feature-figure]')){
      const button=figure.querySelector('.feature-zoom');if(!button)continue;
      const expanded=figure.classList.contains('feature-enlarged');
      const useful=[...figure.querySelectorAll('.feature-crop img')].some(image=>{
        const {width,height}=image.getBoundingClientRect();
        return image.complete&&screenshotNeedsZoom(image.naturalWidth,image.naturalHeight,width,height);
      });
      button.hidden=!expanded&&!useful;
      figure.querySelector('.feature-figure-parts').tabIndex=expanded?0:-1;
      if(button.hidden&&element.ownerDocument.activeElement===button){figure.tabIndex=-1;figure.focus({preventScroll:true});}
    }
  }
  function scheduleZoom(){if(!disposed&&!zoomFrame)zoomFrame=view.requestAnimationFrame(()=>{zoomFrame=0;refreshZoom();});}
  function observeZoom(){
    zoomObserver?.disconnect();
    if(view.ResizeObserver){zoomObserver=new view.ResizeObserver(scheduleZoom);zoomObserver.observe(element);for(const image of element.querySelectorAll('.feature-crop img'))zoomObserver.observe(image);}
    scheduleZoom();
  }
  function applyFold(){for(const s of element.querySelectorAll('[data-feature-section]')){const open=!folded.has(s.id);s.querySelector(':scope>.standard-section-body').hidden=!open;const b=s.querySelector(':scope>[data-section-heading]>.standard-value-toggle');b.setAttribute('aria-expanded',String(open));b.querySelector('img').src=icon(s.dataset.infovalue,open);}navigation?.refresh();scheduleZoom();}
  function reveal(id){const n=[...element.querySelectorAll('[id]')].find(n=>n.id===id);if(!n)return;for(let p=n;p&&p!==element;p=p.parentElement)if(p.dataset.featureSection!==undefined)folded.delete(p.id);applyFold();navigation?.close();scroll().scrollTop+=n.getBoundingClientRect().top-scroll().getBoundingClientRect().top-20;n.tabIndex=-1;n.focus({preventScroll:true});}
  function render(next){const oldTop=scroll()?.scrollTop??0;navigation?.dispose();lang=next;const en=lang==='en',p=publications[lang],labels=en?names:['核心','重要','常规','折叠'];
    element.innerHTML=`<header class="standard-bar"><div class="standard-bar-title"><strong>${en?'Features':'采云功能'}</strong></div><div class="standard-controls">${values.map((v,i)=>`<button type="button" class="standard-category-toggle" data-standard-menu="${v}" aria-controls="features-navigation" aria-expanded="false"><img src="${icon(v)}" alt=""><span>${labels[i]}</span></button>`).join('')}<button type="button" class="standard-toc-toggle" data-standard-menu="all" aria-controls="features-navigation" aria-expanded="false">☷ ${en?'Contents':'目录'} ⌄</button></div><button type="button" class="standard-return cloudig-button cloudig-button-filled">↶ ${en?'Return':'返回'}</button><section class="standard-nav-panel" id="features-navigation" hidden><header><div><strong class="standard-nav-heading"></strong><span class="standard-nav-count"></span></div><p>${en?'Hover to navigate; click a value to fold its sections.':'悬停查看目录；点击信息价值折叠或展开对应章节。'}</p></header><nav data-scroll-region tabindex="-1"></nav></section></header><div class="standard-scroll" data-scroll-region tabindex="0"><div class="feature-reading"><header class="feature-heading"><p>KEEP · ORGANIZE · READ</p><h1>${esc(p.title)}</h1><span>${en?'From the first saved conversation to your own time system.':'从第一份收藏，到属于自己的时间体系。'}</span></header><article class="standard-prose feature-prose"></article></div></div>`;
    const article=element.querySelector('article');
    for(const s of p.sections){const n=document.createElement('section');n.id=s.id;n.className=`standard-section feature-section feature-rank-${s.rank}`;n.dataset.infovalue=s.value;n.dataset.featureSection='';n.innerHTML=`<h${s.rank} data-section-heading><button type="button" class="standard-value-toggle" aria-controls="${s.id}-body" aria-expanded="true" aria-label="${en?'Fold or expand':'折叠或展开'} ${esc(s.label)}"><img src="${icon(s.value)}" alt=""></button>${esc(s.label)}</h${s.rank}><div class="standard-section-body" id="${s.id}-body">${s.html}</div>`;(s.parent?article.querySelector(`#${s.parent}-body`):article).append(n);}
    for(const f of element.querySelectorAll('[data-feature-figure]')){
      const id=f.dataset.featureFigure,stage=document.createElement('div');stage.className='feature-figure-parts';
      if(id==='02-archiver')stage.innerHTML=`<div class="feature-region-map" role="img" aria-label="${en?'Archiver: bookmark panel, source and archive columns, function navigation':'档案馆区域关系示意：左侧书签，中间来源与档案，右侧功能导航'}"><div class="feature-map-title">${en?'Archiver · region diagram':'档案馆 · 区域关系示意'}</div>${(en?['Bookmarklets','Sources → Parse','Conversation archives','Functions & guides']:['书签安装','来源 → 解析','对话档案','功能与文档']).map((t,i)=>`<div class="feature-map-cell feature-map-${i}"><b>0${i+1}</b><span>${t}</span></div>`).join('')}</div>`;
      else for(const key of p.figures[id]){const part=document.createElement('div');part.className='feature-crop';part.dataset.crop=key;const entry=key.endsWith('-entry');if(entry){part.classList.add('feature-entry');const label=document.createElement('span');label.textContent=en?'Entrance':'操作入口';part.append(label);}for(const theme of ['dawn','star-night']){const asset=p.images[key][theme],image=document.createElement('img');image.src=`/Cloudig/pages/document/assets/function-guide/${asset.file}`;image.width=asset.width;image.height=asset.height;image.loading='lazy';image.decoding='async';image.className=`feature-shot-${theme}`;image.alt=f.querySelector('figcaption').textContent;part.append(image);}stage.append(part);}
      f.prepend(stage);
      if(id!=='02-archiver'){
        const zoom=document.createElement('button');zoom.type='button';zoom.className='feature-zoom cloudig-button cloudig-button-outline';zoom.hidden=true;zoom.setAttribute('aria-expanded','false');zoom.textContent=en?'View larger image':'查看大图';
        stage.dataset.scrollRegion='';stage.tabIndex=-1;
        zoom.addEventListener('click',()=>{if(zoom.hidden)return;const expanded=f.classList.toggle('feature-enlarged');zoom.setAttribute('aria-expanded',String(expanded));zoom.textContent=en?(expanded?'Fit to reading width':'View larger image'):(expanded?'恢复适合宽度':'查看大图');stage.scrollTop=0;stage.scrollLeft=0;refreshZoom();});f.append(zoom);
      }
    }
    navigation=mountDocumentNavigation({element,language:lang,values,labels,iconPath:icon,isExpanded:n=>!folded.has(n.id),toggleValue(v){const ns=[...element.querySelectorAll(`[data-feature-section][data-infovalue="${v}"]`)];const close=ns.every(n=>!folded.has(n.id));for(const n of ns)close?folded.add(n.id):folded.delete(n.id);applyFold();}});
    for(const b of element.querySelectorAll('.standard-value-toggle'))b.addEventListener('click',()=>{const id=b.closest('section').id;folded.has(id)?folded.delete(id):folded.add(id);applyFold();});
    element.querySelector('.standard-return').addEventListener('click',onClose);applyFold();observeZoom();scroll().scrollTop=oldTop;element.dataset.documentReady='true';
  }
  element.addEventListener('click',e=>{const a=e.target.closest('a');if(!a)return;e.preventDefault();if(a.dataset.documentTarget)onDocument(a.dataset.documentTarget);else if(a.getAttribute('href').startsWith('#'))reveal(a.getAttribute('href').slice(1));else if(/^https?:/u.test(a.href))onExternal(a.href);});
  element.addEventListener('load',scheduleZoom,true);element.addEventListener('error',scheduleZoom,true);view.addEventListener('resize',scheduleZoom);
  render(lang);center.classList.add('standard-document-host');center.append(element);scheduleZoom();page.dataset.document='features';page.querySelector('[data-doc-topic=archive]')?.setAttribute('aria-current','page');
  return {element,updateLanguage(l){if(l!==lang)render(l);},close(){disposed=true;zoomObserver?.disconnect();if(zoomFrame)view.cancelAnimationFrame(zoomFrame);view.removeEventListener('resize',scheduleZoom);element.removeEventListener('load',scheduleZoom,true);element.removeEventListener('error',scheduleZoom,true);navigation?.dispose();element.remove();center.classList.remove('standard-document-host');delete page.dataset.document;page.querySelector('[data-doc-topic=archive]')?.removeAttribute('aria-current');}};
}
