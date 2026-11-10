import type {Condition,Timeline,MediaRecipe,ConditionCatalog,UserTimeline,BuilderDraftCollection,BuilderDraftSection,BuilderDraft,BuilderPublishPreview} from '../types'
import {fetchJSON} from '../api/transport'
import * as personal from '../explorer/drafts'
import type {PersistenceAdapter} from './persistence'
async function catalog():Promise<ConditionCatalog> {return personal.overlayCatalog(await fetchJSON<ConditionCatalog>('/condition-catalog'))}
export const persistence:PersistenceAdapter = {
 async getConditions(signal){const [published,all]=await Promise.all([fetchJSON<Condition[]>('/conditions',{signal}),catalog()]);return [...published,...all.conditions.filter(c=>c.condition.startsWith('draft:')).map(c=>({name:c.condition,nutrients:c.nutrients,doubling_time:c.doubling_time&&Number.isFinite(Number(c.doubling_time))?Number(c.doubling_time):null}))]},
 async getTimelines(){return (await catalog()).timelines.map(t=>({name:t.timeline,definition:t.events}))},
 async getMediaRecipes(){const published=await fetchJSON<MediaRecipe[]>('/media-recipes');const extras=(await catalog()).media_recipes.filter(r=>r.media_id.startsWith('draft:'));return [...published,...extras.map(r=>({id:r.media_id.slice('draft:'.length),...r}))]},
 getConditionCatalog:catalog,
 async getUserTimelines(){return []},
 async saveUserTimeline(){throw new Error('Save this timeline in Conditions Builder to keep it in your browser drafts')},
 getBuilderDrafts:()=>personal.builderDrafts(),
 async createBuilderDraft(section,name,payload){return personal.builderRecord(await personal.saveDraft(section,name,payload))},
 async updateBuilderDraft(section,id,name,payload){return personal.builderRecord(await personal.saveDraft(section,name,payload,String(id)))},
 async publishBuilderDraft(section,id){return personal.applyDraft(String(id),await catalog())},
 async previewBuilderDraft(section,id){const d=await personal.getDraft(String(id));return {section,draft_id:d.id,draft_name:d.name,changes:[{file:'Personal browser overlay',action:'apply',rows:[JSON.stringify(d.payload,null,2)]}],warnings:['Planning only: catalog checks do not establish runtime readiness. No shared reference data will change.']}},
}
