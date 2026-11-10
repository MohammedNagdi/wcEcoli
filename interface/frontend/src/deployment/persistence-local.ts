import {fetchJSON} from '../api/transport'
import type {PersistenceAdapter} from './persistence'
export const persistence:PersistenceAdapter = {
 getConditions:signal=>fetchJSON('/conditions',{signal}),
 getTimelines:()=>fetchJSON('/timelines'),
 getMediaRecipes:()=>fetchJSON('/media-recipes'),
 getConditionCatalog:()=>fetchJSON('/condition-catalog'),
 getUserTimelines:()=>fetchJSON('/user-timelines'),
 saveUserTimeline:(name,definition)=>fetchJSON('/user-timelines',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,definition})}),
 getBuilderDrafts:()=>fetchJSON('/builder-drafts'),
 createBuilderDraft:(section,name,payload)=>fetchJSON(`/builder-drafts/${section}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,payload})}),
 updateBuilderDraft:(section,id,name,payload)=>fetchJSON(`/builder-drafts/${section}/${id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,payload})}),
 publishBuilderDraft:(section,id)=>fetchJSON(`/builder-drafts/${section}/${id}/publish`,{method:'POST'}),
 previewBuilderDraft:(section,id)=>fetchJSON(`/builder-drafts/${section}/${id}/preview`),
}
