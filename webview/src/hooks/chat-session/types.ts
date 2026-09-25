// Thin re-export so components importing from "@/hooks/chat-session/types"
// resolve against the shared contract without a session-diff dependency.
export type {
	AgentChunkEvent,
	ChatUsagePayload,
	ToolCallStartPayload,
	ToolCallEndPayload,
	ToolCallUpdatePayload,
	ChatDonePayload,
	ToolApprovalRequestItem,
	ProcessContext,
} from "@shared/types";
