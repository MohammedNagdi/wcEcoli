import type {Condition,Timeline,MediaRecipe,ConditionCatalog,UserTimeline,BuilderDraftCollection,BuilderDraftSection,BuilderDraft,BuilderPublishPreview} from '../types'
export interface PersistenceAdapter {
 getConditions(signal?:AbortSignal):Promise<Condition[]>
 getTimelines():Promise<Timeline[]>
 getMediaRecipes():Promise<MediaRecipe[]>
 getConditionCatalog():Promise<ConditionCatalog>
 getUserTimelines():Promise<UserTimeline[]>
 saveUserTimeline(name:string,definition:string):Promise<UserTimeline>
 getBuilderDrafts():Promise<BuilderDraftCollection>
 createBuilderDraft(section:BuilderDraftSection,name:string,payload:Record<string,unknown>):Promise<BuilderDraft>
 updateBuilderDraft(section:BuilderDraftSection,draftId:number|string,name:string,payload:Record<string,unknown>):Promise<BuilderDraft>
 publishBuilderDraft(section:BuilderDraftSection,draftId:number|string):Promise<BuilderDraft>
 previewBuilderDraft(section:BuilderDraftSection,draftId:number|string):Promise<BuilderPublishPreview>
}
