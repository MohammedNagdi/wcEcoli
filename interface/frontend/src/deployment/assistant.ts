import type {AssistantContext} from '../types'
export interface PageAssistantRegistration {
 context:Partial<AssistantContext>; suggestedPrompt?:string; enabled?:boolean; contextKey?:string
}
export interface ShellAssistantState {isOpen:boolean}
