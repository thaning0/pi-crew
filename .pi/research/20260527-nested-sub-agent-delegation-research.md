# Task Research Notes: Nested/Hierarchical Sub-Agent Spawning & Delegation

## Evidence
- **Files/code**: N/A (cross-framework survey — all evidence from official docs, GitHub repos, published papers, and technical blogs)
- **External sources**:
  - CrewAI Docs: `https://docs.crewai.com/en/learn/hierarchical-process`, `https://docs.crewai.com/en/concepts/collaboration`
  - Claude Code Docs: `https://code.claude.com/docs/en/sub-agents`
  - OpenAI Agents SDK: `https://openai.github.io/openai-agents-python/handoffs/`
  - AutoGen Docs: `https://microsoft.github.io/autogen/stable/.../group-chat.html`
  - LangGraph Hierarchical Teams: `https://colab.research.google.com/github/LangChain-OpenTutorial/.../08-LangGraph-Hierarchical-Multi-Agent-Teams.ipynb`
  - Agent Calling Patterns Survey: `https://openwalrus.xyz/blog/agent-calling-patterns` (cross-framework analysis)
  - Sub-Agent Architectures: `https://dev.to/zrcic/sub-agent-architectures-patterns-trade-offs-and-a-kotlin-implementation-13dh`
  - Claude Code Multi-Agent Architecture: `https://claudecodeguides.com/claude-code-multi-agent-architecture-guide-2026/`
  - Context Management in Agent Harnesses: `https://arize.com/blog/context-management-in-agent-harnesses/`
  - Agent Drift Paper (2026): `https://arxiv.org/html/2601.04170v1`
  - MAST Failure Taxonomy (2025): `https://openwalrus.xyz/blog/agent-calling-patterns` (secondary ref)
  - DyLAN (2024): `https://arxiv.org/abs/2310.02170`
  - ReAcTree (2025): `https://arxiv.org/abs/2511.02424`
  - Majordomo Pattern Analysis: `https://gist.github.com/Donavan/8c121b2acfdc33b1e7401941471762ee`
  - CrewAI allowed_agents PR #2068: `https://github.com/crewAIInc/crewAI/pull/2068`
  - QuantumAi Labs AutoGen Nested Chat: `https://quantumailabs.net/4-steps-to-build-multi-agent-nested-chats-with-autogen/`

---

## Key Findings

### 1. CrewAI — Hub-and-Spoke with Tool-Mediated Delegation

| Property | Detail |
|---|---|
| **Supports nesting?** | **Partial** — hierarchical chains via `allowed_agents` (PR #2068), but static configuration, not dynamic spawning |
| **Max depth** | ~2–3 levels (management executive → communications manager → email agent) |
| **Message routing** | Hub-and-spoke: all tasks flow through a manager agent or are tool-mediated. Default process is `Process.sequential`; `Process.hierarchical` adds a manager LLM. |
| **Context model** | **Shared** — tasks pass `context=[previous_task]` for downstream awareness. Agents share crew-level context. |
| **Delegation mechanism** | When `allow_delegation=True`, agents get two tools: `Delegate Work` (assign task to coworker) and `Ask Question` (query colleague). Other agents are converted into callable tools. |
| **Key design decisions** | Manager LLM separates planning from execution. Delegation is **disabled by default** since v0.x for explicit user control. `allowed_agents` parameter enables constrained hierarchical chains. |
| **Trade-offs** | Simple to reason about; no dynamic sub-agent spawning; delegation chains are static; reports of broken delegation in some configs. Good for structured team workflows; poor for open-ended recursive problem-solving. |

**Architecture**: Agents → Tasks → Crew (with Process.hierarchical). Manager agent allocates tasks to workers, validates results. Manager can be auto-created via `manager_llm` or explicitly defined.

**Evidence**: CrewAI docs show `allowed_agents` enables chains like `management_executive → communications_manager → email_agent`, but this is pre-configured, not dynamic. The agent-calling-patterns survey rates CrewAI delegation depth at ~3 levels, static only.

---

### 2. AutoGen — Broadcast GroupChat with Recursive Nesting

| Property | Detail |
|---|---|
| **Supports nesting?** | **Yes** — explicit support for "recursive group chats" and "nested chats" |
| **Max depth** | **Unlimited** (no hard depth limit) |
| **Message routing** | **Pub-sub broadcast**: all agents subscribe to a shared topic. `GroupChatManager` selects the next speaker (round-robin, random, manual, or LLM-driven). No direct agent-to-agent addressing. |
| **Context model** | **Shared** by default — all agents see the group chat history. Nested chats can have their own sub-conversations with isolated context, results returned to parent. |
| **Delegation mechanism** | `register_nested_chats()` — wraps an inner multi-agent conversation as a single response in the outer conversation. `SequentialChat`, `GroupChat`, and nested variants all supported. |
| **Key design decisions** | Treats all agent interactions as conversations. Nested chat is a first-class primitive — a sub-conversation triggered by a condition, with its own agents and turn limit, collapsing results back to the parent. |
| **Trade-offs** | Broadcast architecture means no direct addressing — everything flows through the manager. Unlimited nesting can lead to runaway token costs. Shared context in group chats grows unboundedly. Nested chats provide isolation but add coordination complexity. |

**Architecture**: Agent → `register_nested_chats(trigger, chat_queue)` → inner conversation (can be any chat type: two-agent, sequential, group) → results returned to outer chat. The example in the QuantumAi article shows an article-writing pipeline: Outline Agent → (nested: Writer ↔ Reviewer × 2 turns) → final article.

**Evidence**: AutoGen 0.2+ docs explicitly describe "recursive group chats" with each participant potentially being a recursive group chat. No depth limit enforced. `max_turns` controls per-nested-chat iteration count.

---

### 3. LangGraph — State-Graph with First-Class Hierarchical Pattern

| Property | Detail |
|---|---|
| **Supports nesting?** | **Yes** — three multi-agent patterns: Supervisor, Swarm, and **Hierarchical** (supervisors managing supervisors) |
| **Max depth** | ~25 supersteps default (`recursion_limit`), configurable |
| **Message routing** | **Graph-based state machine**: nodes are agents, edges define transitions. In supervisor mode, routing goes through coordinator. In swarm mode, agents can hand off to peers based on their own assessment. |
| **Context model** | **Flexible** — sub-graphs can have **different state schemas** from parent graphs, enabling private message histories per agent. Shared state via `StateGraph` is also available. |
| **Delegation mechanism** | Subgraphs as nodes; agent nodes can invoke tool-calling, handoffs, or other subgraphs. `RemoteGraph` enables distributed graph execution across processes/machines. |
| **Key design decisions** | LangGraph is the most flexible framework — choose between supervisor (centralized), swarm (decentralized peer-to-peer), or hierarchical (nested supervisors). State is explicit and typed. |
| **Trade-offs** | Maximum flexibility comes with maximum complexity. You build the routing logic yourself. Debugging nested graphs is harder than flat architectures. The `recursion_limit` is a safety guard against infinite loops. |

**Architecture**: A `StateGraph` where nodes can be agent invocations, tool calls, or nested `StateGraph` instances. The hierarchical pattern creates a top-level supervisor that routes to mid-level supervisors, each managing their own team. Private state schemas per sub-graph enable context isolation.

**Evidence**: The LangGraph tutorial notebook (`08-LangGraph-Hierarchical-Multi-Agent-Teams.ipynb`) demonstrates a two-level hierarchy: top supervisor → mid-level supervisors (research team, writing team) → worker agents. `recursion_limit` defaults to ~25, configurable per graph.

---

### 4. Coding Agents (Claude Code, Cursor, Devin)

#### Claude Code — Single-Level, Flat Sub-Agent Model

| Property | Detail |
|---|---|
| **Supports nesting?** | **No — explicitly prevented**. Sub-agents **cannot** spawn other sub-agents. |
| **Max depth** | **1 level** (hardcoded). Users who attempted nesting via `claude -p` in Bash encountered heap OOM crashes. |
| **Message routing** | **Strictly one-way**: parent sends prompt → sub-agent returns final message. No mid-execution streaming, callbacks, or bidirectional communication. |
| **Context model** | **Isolated** — sub-agents get their own context window with custom system prompt. No parent conversation history passed (except experimental fork mode). |
| **Delegation mechanism** | `Task` tool (not available to sub-agents). Up to 10 sub-agents run in **parallel**. Sub-agents defined as Markdown files with YAML frontmatter (`name`, `description`, `tools`, `model`, etc.). |
| **Key design decisions** | Sub-agents are **context-preservation tools** — keep exploration (file reads, searches, logs) out of the main conversation. Built-in sub-agents: Explore (Haiku, read-only), Plan (read-only), General-purpose (all tools). |
| **Trade-offs** | Simple, safe, fast. No recursive problem decomposition. Sub-agents can "fake" work (silently abandon strategies) with no parent visibility. 10-subagent parallel limit. Plan sub-agent explicitly prevents infinite nesting. |

**Architecture**: Main agent → spawns sub-agents via `Agent` tool → each runs in isolated context → returns results. Sub-agents can be configured per-project (`.claude/agents/`), per-user (`~/.claude/agents/`), or via CLI flags (`--agents`). Model selection: `sonnet`, `opus`, `haiku`, or `inherit`. Optional `isolation: worktree` for git-isolated sub-agents.

**Evidence**: Claude Code docs explicitly state: "subagents cannot spawn other subagents." The `Plan` subagent documentation says "This prevents infinite nesting." The agent-calling-patterns survey confirms: "Nesting depth: 1 level, hardcoded."

#### Cursor — No Public Sub-Agent Architecture

Cursor does not expose a documented sub-agent spawning mechanism. Its agent mode operates as a single-agent loop. No evidence of nested delegation.

#### Devin — Cloud-Based Parallel Agent Workers

Devin operates as a cloud-based autonomous coding agent. It can spawn **parallel cloud agents** for concurrent task execution. The architecture appears to be a single-level fan-out (orchestrator → multiple workers), similar to Claude Code. No evidence of recursive/nested spawning documented publicly.

---

### 5. OpenAI Agents SDK — Bidirectional Mesh with Beta Nesting

| Property | Detail |
|---|---|
| **Supports nesting?** | **Yes** — bidirectional handoffs with `nest_handoff_history` (opt-in beta) |
| **Max depth** | **Unlimited** (beta context management for deep chains) |
| **Message routing** | **Bidirectional handoffs** and **agents-as-tools**. Agent A lists Agent B in `handoffs`; Agent B can list Agent A back. Enables circular flows: A → B → A. Full conversation history preserved across transfers. |
| **Context model** | **Shared by default** — conversation history flows with handoffs. `nest_handoff_history` beta collapses prior transcripts into summary messages with `<CONVERSATION HISTORY>` blocks. `input_filter` allows per-handoff history customization. |
| **Delegation mechanism** | Two patterns: **(1) Handoffs** — transfer conversation ownership to another agent via `handoff()` function. **(2) Agents-as-tools** — wrap agent as callable tool with structured input/output. Handoffs support `on_handoff` callbacks, `input_type` for model-generated metadata, and `input_filter` for history modification. |
| **Key design decisions** | Handoffs are the only framework where **true peer-to-peer** is a core primitive. `nest_handoff_history` is opt-in beta (disabled by default). The framework provides `handoff_filters.remove_all_tools` for common patterns. Recommended prompt prefix via `handoff_prompt.RECOMMENDED_PROMPT_PREFIX`. |
| **Trade-offs** | Bidirectional handoffs are powerful but risky — documented case of **9+ day circular relay consuming 60,000+ tokens**. Beta status of nesting means production caution. Guardrails apply only to first agent; output guardrails only to final output agent. |

**Architecture**: `Agent` objects with `handoffs=[...]` parameter. The `handoff()` helper transforms agent references into tool calls available to the LLM. Nested handoffs collapse history into summary blocks. `RunConfig.nest_handoff_history` enables the beta nesting behavior globally or per-handoff.

**Evidence**: OpenAI Agents SDK docs detail `nest_handoff_history`, `input_filter`, `handoff_filters`, and the recommended handoff prompt. The agent-calling-patterns survey notes this is "the only framework where true peer-to-peer communication is a core primitive."

---

## Cross-Framework Comparison

| Framework | Nesting | Max Depth | Routing | Context | Peer-to-Peer |
|---|---|---|---|---|---|
| **Claude Code** | ❌ No | 1 | One-way (parent→child) | Isolated | No |
| **CrewAI** | ⚠️ Static only | ~3 | Hub-spoke (manager/tools) | Shared | Via delegation tools |
| **AutoGen** | ✅ Yes | Unlimited | Pub-sub broadcast | Shared (or isolated nested) | Via broadcast |
| **LangGraph** | ✅ Yes | ~25 (configurable) | Graph-based state machine | Flexible (private or shared) | Yes (swarm mode) |
| **OpenAI Agents SDK** | ✅ Yes (beta) | Unlimited | Bidirectional handoffs | Shared (with nested summaries) | Yes (core primitive) |
| **OpenClaw** | ✅ Yes | 1-5 (configurable) | One-way (announce result) | Isolated | No |
| **Google ADK** | ✅ Yes | Unlimited | Tree (shared whiteboard) | Shared state | Indirect only |
| **Semantic Kernel** | ✅ Yes | Unlimited | Pattern-dependent | Shared | Yes (handoff/group chat) |

---

## Academic & Industry Research

### Agent Drift (Jan 2026) — "Two-Level Hierarchies Outperform Flat and Deep"
- **Paper**: "Agent Drift: Quantifying Behavioral Degradation in Multi-Agent LLM Systems" (arXiv:2601.04170)
- **Key finding**: Two-level hierarchies (router + specialists) **significantly outperform** both flat (peer-to-peer) and deep (3+ level) architectures in stability
- **ASI metric**: Agent Stability Index measuring drift across 12 dimensions
- **Drift incidence by 500 interactions**: Financial analysis (53.2%), Compliance (39.7%), Enterprise automation (31.8%)
- **Mitigation effectiveness**: Adaptive Behavioral Anchoring (70.4% drift reduction), combined strategies (81.5%)
- **Architecture insights**: Explicit long-term memory shows 21% higher ASI retention than conversation-history-only systems

### MAST Failure Taxonomy (Mar 2025) — 14 Failure Modes, 41-87% Failure Rate
- Analyzed 1,600+ traces across 7 frameworks
- **3 categories**: Specification failures, Inter-agent misalignment, Verification failures
- **Production failure rate**: 41-87% across multi-agent systems
- **No single failure category dominates** — failures are diverse across architectures

### DyLAN (2024) — Dynamic Teams Outperform Static
- **Paper**: "Dynamic LLM-Powered Agent Network" (arXiv:2310.02170, COLM 2024)
- **Key finding**: LLM-powered agent selection with "Agent Importance Score" improves accuracy by up to 25% over static teams
- Dynamic team formation outperforms fixed agent sets

### ReAcTree (2025) — Hierarchical Agent Trees
- **Paper**: "ReAcTree: Hierarchical LLM Agent Trees with Control Flow for Long-Horizon Task Planning" (arXiv:2511.02424)
- Dynamically constructs agent trees by decomposing complex goals into manageable subgoals
- Each subgoal spawns a focused sub-agent in a tree structure

### Majordomo Pattern (2023) — Role-Based Hierarchical Delegation
- Defines roles: Majordomo (orchestrator), Steward (router), Staffing Director (agent creator), Chief of Protocol (verifier)
- Aligns with MetaGPT, ChatDev, HyperAgent architectures
- Dynamic agent creation is rare in current frameworks; fixed agent sets are the norm

### Context Management Convergence (Arize, 2025)
- Survey of Pi, OpenClaw, Claude Code, Letta context management
- All four: hard-cap file reads, offset/limit pagination, cap tool results, isolate sub-agent sessions, LLM-powered compaction by token threshold
- "Context preheating" via sub-agents: using sub-agents to gather/research context separately, then returning only the summary to the parent — keeps parent context clean

---

## Recommended Approaches

### Option A: Two-Level Hierarchy (Recommended by Research)
**Principle**: The Agent Drift paper and the agent-calling-patterns survey both conclude that two-level hierarchies (orchestrator + specialists) outperform flat (no coordination) and deep (3+, information degradation) architectures.

**Architecture**: Main orchestrator agent → spawns specialized sub-agents for self-contained tasks → sub-agents return results → orchestrator synthesizes.

**Key properties**:
- Sub-agents get **isolated context** (fresh window, no parent history) — prevents context pollution
- Sub-agents get **restricted tool sets** — improves decision quality (Gorilla benchmark evidence)
- Sub-agents **cannot spawn further sub-agents** (structurally enforced, not prompt-based) — prevents runaway recursion
- Configurable max sub-agents (recommend 5-10, based on Claude Code limit)
- Async dispatch for independent tasks

**Dependencies**: Minimal — requires only a spawn mechanism and context isolation. Model-agnostic.

**Success criteria**: ASI drift within acceptable range (<0.75 for 100+ interactions); no infinite recursion; parent context remains manageable.

**Project compatibility**: High. The pi-crew room system already uses sub-agents (researchers). Adding a two-level constraint and structural spawn prevention aligns with the existing architecture.

### Option B: LangGraph-Style Flexible Nesting (Maximum Power)
**Principle**: Support arbitrary nesting depth with configurable recursion limits and private state per sub-graph.

**Architecture**: Each agent is a node in a state graph. Agents can invoke sub-graphs that have their own state schemas. Recursion controlled by `recursion_limit`.

**Key properties**:
- Agents can be supervisors, workers, or both
- Private message histories per agent (separate state schemas)
- Can implement swarm (peer-to-peer), supervisor (centralized), or hierarchical patterns
- Configurable depth limits

**Dependencies**: Requires state graph infrastructure, schema management, recursive graph execution.

**Success criteria**: Same as Option A, but with deeper task decomposition capability. Higher complexity cost.

**Project compatibility**: Medium. Significant architectural changes needed to support recursive sub-graphs.

### Option C: OpenAI-Style Bidirectional Handoffs (Maximum Flexibility)
**Principle**: Agents can hand off to each other bidirectionally. The system is a mesh, not a tree.

**Architecture**: Each agent lists other agents in its `handoffs` array. Conversation history flows with the handoff. Nested handoff history management collapses deep chains.

**Key properties**:
- True peer-to-peer communication
- Agents can escalate back to parent
- Beta `nest_handoff_history` for context management
- Risk of circular relays (documented 9-day case)

**Dependencies**: Handoff protocol, conversation history management, circuit breakers.

**Success criteria**: Flexible delegation without infinite loops (requires circuit breakers, max-depth guards).

**Project compatibility**: Low-Medium. Bidirectional handoffs introduce significant coordination complexity. The research consensus leans against this for reliability.

---

## Key Design Insights for pi-crew

1. **Two levels is the sweet spot**: Academic research (Agent Drift 2026) and industry consensus (Claude Code, OpenClaw defaults) both converge on two-level hierarchies as optimal.

2. **Prevent recursion structurally, not via prompts**: AIgent's `baseTools` (without `spawn_agent`) pattern is the right approach. Claude Code hardcodes "subagents cannot spawn subagents."

3. **Isolate sub-agent context**: All frameworks converge on giving sub-agents their own context window. The parent should receive only the result, not intermediate chatter.

4. **Restrict sub-agent tools**: Tool scoping improves decision quality. Gorilla benchmark shows tool-use accuracy degrades with scale.

5. **Sub-agent failures are silent**: Sub-agents returning empty/nonsensical results are indistinguishable from valid ones at the string boundary. Structured return types (success/error) are essential.

6. **Avoid shared state for coordination**: Google ADK's "shared whiteboard" and LangGraph's shared state enable implicit coupling — any agent can read/overwrite state another agent depends on. Message passing is more explicit but adds protocol complexity.

7. **Context management matters more than nesting depth**: The Arize survey shows all major harnesses converging on the same context patterns (compaction, pagination, isolation). The pi-crew's existing compaction mechanism aligns with industry best practices.
