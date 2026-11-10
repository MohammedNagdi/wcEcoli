/** Pure link registry: safe to import from shared components without starting explorer code. */
export const GUIDE_SECTION_IDS = ['overview','variants','conditions','timelines','parameters','workflows','results','shortcuts'] as const
export type GuideSection = typeof GUIDE_SECTION_IDS[number]
export const GUIDE_TOPICS = {
  'model-coverage':{section:'overview',heading:'Model coverage and gene context'},
  mechanistic:{section:'overview',heading:'Mechanistic genes'},
  'expression-only':{section:'overview',heading:'Expression-only genes'},
  'model-state-ids':{section:'overview',heading:'Model state identifiers'},
  'knockout-index':{section:'parameters',heading:'Knockout indices and transcription-unit targets'},
} as const
export type GuideTopicId = keyof typeof GUIDE_TOPICS
export type GuideTarget = {kind:'topic';id:GuideTopicId}|{kind:'variant';name:string}
export function guideTopicHref(topic:GuideTopicId){return '/guide?'+new URLSearchParams({section:GUIDE_TOPICS[topic].section,topic}).toString()}
export function guideVariantHref(variant?:string){return '/guide?'+new URLSearchParams(variant?{section:'variants',variant}:{section:'variants'}).toString()}
export function resolveGuideDestination(params:URLSearchParams):{section:GuideSection;target:GuideTarget|null;notice:string;canonical:string|null}{
  const requested=params.get('section')||'overview'
  const known=(GUIDE_SECTION_IDS as readonly string[]).includes(requested)
  let section:GuideSection=known?requested as GuideSection:'overview',target:GuideTarget|null=null
  let notice=known?'':requested==='assistant'?'Assistant is not available in this explorer. The overview explains the supported tools.':'That guide section is unavailable. Showing the explorer overview.'
  if(params.has('topic')&&params.has('variant'))notice='Choose a single guide topic or experiment type. No contextual explanation has been selected.'
  else if(params.has('topic')){
    const id=params.get('topic')||''
    if(Object.prototype.hasOwnProperty.call(GUIDE_TOPICS,id)){
      const topic=id as GuideTopicId;section=GUIDE_TOPICS[topic].section;target={kind:'topic',id:topic};notice=''
    }else notice='That guide topic is unavailable. No contextual explanation has been selected.'
  }else if(params.has('variant')){
    const name=params.get('variant')||''
    if(/^[A-Za-z0-9_]+$/.test(name)){section='variants';target={kind:'variant',name};notice=''}
    else notice='That experiment type is unavailable. No contextual explanation has been selected.'
  }
  const next=new URLSearchParams(params)
  if(target&&params.get('section')!==section){next.set('section',section);return {section,target,notice,canonical:next.toString()}}
  return {section,target,notice,canonical:null}
}
