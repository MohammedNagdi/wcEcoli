import {useAssistant as useLocalAssistant} from '../components/assistant/AssistantProvider'
import type {ShellAssistantState} from './assistant'
export {useRegisterAssistantContext} from '../components/assistant/AssistantProvider'
export {AssistantDock} from '../components/assistant/AssistantDock'
export function useAssistant():ShellAssistantState {return useLocalAssistant()}
