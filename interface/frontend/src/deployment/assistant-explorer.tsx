import type {PageAssistantRegistration,ShellAssistantState} from './assistant'
const disabled:ShellAssistantState=Object.freeze({isOpen:false})
export function useAssistant():ShellAssistantState {return disabled}
export function useRegisterAssistantContext(_registration:PageAssistantRegistration):void {}
export function AssistantDock(_props:{besideWorkspace?:boolean}) {return null}
