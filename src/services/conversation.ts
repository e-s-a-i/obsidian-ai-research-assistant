import { v4 as uuidv4 } from 'uuid'

import formatInput from '../utils/formatInput'
import getUnixTimestamp from 'src/utils/getUnixTimestamp'

import {
  PLUGIN_SETTINGS,
  DEFAULT_CONVERSATION_TITLE,
  USER_MESSAGE_OBJECT_TYPE,
  DEFAULT_MAX_MEMORY_COUNT,
} from '../constants'
import { OPEN_AI_DEFAULT_MODEL, OPEN_AI_COMPLETION_OBJECT_TYPE } from './openai/constants'
import type { ModelDefinition, OpenAICompletion } from './openai/types'
import type {
  UserPrompt,
  ConversationMessageType,
  ConversationMessage,
  PluginSettings,
  MemoryState,
} from '../types'

export interface ConversationInterface {
  id: string
  title: string
  preamble: string
  timestamp: number
  messages: ConversationMessage[]
  model?: ModelDefinition
  settings: PluginSettings
}

export class Conversation {
  id: ConversationInterface['id']
  preamble: ConversationInterface['preamble']
  title: ConversationInterface['title']
  timestamp: ConversationInterface['timestamp']
  messages: ConversationInterface['messages']
  context: string
  model: ModelDefinition
  settings: PluginSettings
  hasMemory: boolean

  constructor({
    title = DEFAULT_CONVERSATION_TITLE,
    preamble = '',
    timestamp = getUnixTimestamp(),
    id = uuidv4(),
    messages = [],
    model = OPEN_AI_DEFAULT_MODEL,
    settings = PLUGIN_SETTINGS,
  }: Partial<ConversationInterface>) {
    this.id = id
    this.preamble = preamble
    this.title = title
    this.timestamp = timestamp
    this.messages = messages
    this.context = preamble
    this.model = model
    this.settings = settings
    this.hasMemory = settings.enableMemory
  }

  setHasMemory(hasMemory: boolean): void {
    this.hasMemory = hasMemory
  }

  getContext(includePreamble: boolean = false): string {
    // TODO: summarize the prompt (or maybe the response from OpenAI) and add it to the context
    // instead of just appending the message
    const contextMessages = []

    if (this.settings.enableMemory) {
      const maxMemories = this.settings.maxMemoryCount ?? DEFAULT_MAX_MEMORY_COUNT

      // get all memories that haven't been forgotten
      const memories = [...this.messages].filter(({ memoryState }) => memoryState !== 'forgotten')

      // get core memories take precedence
      contextMessages.push(
        ...memories
          .filter(({ memoryState }) => memoryState === 'core')
          // borrowed from: https://stackoverflow.com/a/6473869/656011
          .slice(Math.max(contextMessages.length - maxMemories, 0))
      )

      if (contextMessages.length < maxMemories) {
        // specific memories come next
        contextMessages.push(
          ...memories
            .filter(({ memoryState }) => memoryState === 'remembered')
            // borrowed from: https://stackoverflow.com/a/6473869/656011
            .slice(Math.max(contextMessages.length - maxMemories, 0))
        )
      }

      if (contextMessages.length < maxMemories) {
        // most recent mesages come last
        contextMessages.push(
          ...[...memories]
            // reverse chronological order
            .reverse()
            // make sure we're looking at the default memories
            .filter(({ memoryState }) => memoryState === 'default')
            // borrowed from: https://stackoverflow.com/a/6473869/656011
            .slice(Math.max(contextMessages.length - maxMemories, 0))
            // shift back to chronological order
            .reverse()
        )
      }
    }

    const formattedContextMessages = contextMessages

      // get formatted message text
      .map((message) => {
        if (message.message.object === USER_MESSAGE_OBJECT_TYPE) {
          return this.formatMessagePart(
            `${this.settings.userPrefix}\n${(message.message as UserPrompt).prompt}`
          )
        } else if (message.message.object === OPEN_AI_COMPLETION_OBJECT_TYPE) {
          return this.formatMessagePart(
            `${this.settings.botPrefix}\n${(message.message as OpenAICompletion).choices[0].text}`
          )
        } else {
          return ''
        }
      })

    // if we want to include our preamble in the context, add it to the beginning of the array
    if (includePreamble && this.preamble !== '') {
      formattedContextMessages.unshift(this.preamble)
    }

    return formatInput(formattedContextMessages.join('\n'))
  }

  formatMessagePart(part: string = '', prefix = true, suffix = false): string {
    if (typeof part !== 'undefined' && part !== null && part !== '') {
      return `${
        prefix && typeof this?.model?.startWord !== 'undefined' ? this.model.startWord : ''
      }${part}${suffix && typeof this?.model?.stopWord !== 'undefined' ? this.model.stopWord : ''}`
    } else {
      return ''
    }
  }

  getFullMessageText(message: ConversationMessage | ConversationMessage['message']): string {
    let currentMessage = message as ConversationMessageType

    if (typeof (message as ConversationMessage)?.message !== 'undefined') {
      currentMessage = (message as ConversationMessage).message
    }

    if (currentMessage.object === USER_MESSAGE_OBJECT_TYPE) {
      return formatInput(
        `${this.formatMessagePart(this.preamble)}${this.getContext()}${this.formatMessagePart(
          `${this.settings.userPrefix}\n${(currentMessage as UserPrompt).prompt}`
        )}${this.formatMessagePart(`${this.settings.botPrefix}\n`, true)}`
      )
    } else if (currentMessage.object === OPEN_AI_COMPLETION_OBJECT_TYPE) {
      return formatInput(
        `${this.formatMessagePart(
          `${this.settings.botPrefix}\n${(currentMessage as OpenAICompletion).choices[0].text}`
        )}`
      )
    } else {
      return this.formatMessagePart(JSON.stringify(currentMessage))
    }
  }

  addMessage(message: Partial<ConversationMessageType>): ConversationMessage {
    const conversationMessage: ConversationMessage = {
      id:
        typeof (message as OpenAICompletion)?.id !== 'undefined'
          ? (message as OpenAICompletion).id
          : uuidv4(),
      memoryState: 'default' as MemoryState,
      message: message as ConversationMessage['message'],
    }

    if (typeof conversationMessage?.message?.created === 'undefined') {
      conversationMessage.message.created = getUnixTimestamp()
    }

    if (conversationMessage.message.object === USER_MESSAGE_OBJECT_TYPE) {
      const inputText = formatInput(`${(message as UserPrompt).prompt}`)
      const inputContext = formatInput(this.getContext(true))
      const fullText = formatInput(this.getFullMessageText(conversationMessage.message))

      ;(message as UserPrompt).context = inputContext
      ;(message as UserPrompt).prompt = inputText
      ;(message as UserPrompt).fullText = fullText

      this.context = this.getFullMessageText(message as ConversationMessageType)
    } else if (conversationMessage.message.object === OPEN_AI_COMPLETION_OBJECT_TYPE) {
      this.context = this.getFullMessageText(message as ConversationMessageType)
    } else {
      conversationMessage.memoryState = 'forgotten' as MemoryState

      conversationMessage.message = {
        object: 'system_message',
        created: getUnixTimestamp(),
        output: JSON.stringify(message),
      }
    }

    this.messages.push(conversationMessage)

    return conversationMessage
  }

  updateTitle(title: string): void {
    this.title = title
  }

  updateContext(context: string): void {
    this.context = context
  }
}

export interface ConversationManagerInterface {
  conversations: Record<string, Conversation>
}

export class ConversationManager {
  conversations: ConversationManagerInterface['conversations']
  currentConversationId: string | null = null

  constructor() {
    this.conversations = {}
  }

  startConversation({ preamble, title, settings }: Partial<Conversation>): Conversation {
    const conversation = new Conversation({
      preamble,
      title,
      settings,
    })

    this.conversations[conversation.id] = conversation

    this.currentConversationId = conversation.id

    return conversation
  }

  currentConversation(): Conversation | null {
    if (this.currentConversationId === null) {
      return null
    }

    return this.conversations[this.currentConversationId]
  }

  getConversation(id: string): Conversation | null {
    if (typeof this.conversations[id] !== 'undefined') {
      return this.conversations[id]
    }

    return null
  }

  updateConversationTitle(id: string, title: string): void {
    this.conversations[id].updateTitle(title)
  }

  addMessage(id: string, message: ConversationMessage): void {
    this.conversations[id].addMessage(message)
  }
}

const Conversations = new ConversationManager()

export default Conversations
