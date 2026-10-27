# Entropy — project charter

**Status:** founding vision, 14 October 2026  
**Owner:** Kars  
**Purpose:** preserve the product intent so implementation can grow without losing sight of why Entropy exists.

## The vision

Entropy is Kars's personal AI workspace: an always-available companion for everyday thinking and work, with a useful interface and a team of agents behind it. It should understand the ongoing context of Kars's projects, help move them forward, and eventually carry out approved tasks in the background—including while Kars is asleep.

Entropy should feel less like a blank chatbot and more like a persistent partner that moves alongside Kars. It should be useful to its owner first, while also being a strong, demonstrable engineering project.

## What Entropy should help with

- Understand a request, clarify its goal, and turn it into an actionable plan.
- Keep project context, decisions, tasks, and useful knowledge available across sessions.
- Delegate work to specialized agents and bring their results back to Kars.
- Use connected tools to do real work, with visible progress and understandable outcomes.
- Work on queued, bounded tasks in the background when the system is running and authorized to do so.
- In the longer term, help create useful products or services that can generate income. This is an ambition to explore, not a promised outcome.

## People and agents

### Kars — owner and human control

Kars sets goals, priorities, and limits. He should be able to speak directly with Entropy and, when useful, with Argus, Redshift, and Wormhole. Entropy remains the main coordinator and is directly connected to Kars.

### The four primary agents

- **Entropy** — orchestrator and primary interface with Kars; understands requests, plans work, delegates, and reports back.
- **Ophira** — researcher; finds and organizes relevant information.
- **Psyche** — analyst and reviewer; challenges assumptions and checks proposed work.
- **Veltrics** — developer; designs, implements, and explains software changes. The current Codex collaboration is the first practical form of this role, not yet a deployed Entropy agent.

### Supporting services

- **Argus** — observability: what the system and agents are doing, their progress, and failures.
- **Redshift** — task management: queued work, ownership, state, and priorities.
- **Wormhole** — tool gateway: controlled access to external tools and services.

These are important system components, but Kars currently imagines them as less personified than the four primary agents.

## Product experience

- A conversational interface should be the natural front door, with a visual workspace available for projects, tasks, agents, and results.
- Kars should be able to see what Entropy is doing, what it plans to do next, and what requires his decision.
- The interface should make long-running work understandable: queued, active, waiting, completed, or failed, with a useful result and a record of what happened.
- Entropy should preserve durable project context without pretending it can literally know every fact or retain every conversation automatically. Important knowledge must be captured, searchable, and correctable.

## Autonomy and trust

Entropy should earn autonomy gradually. Background work requires a running service, configured models and tools, and explicit operating limits. It cannot keep working while a local computer is asleep unless the work is hosted somewhere that remains online.

Work should have a clear scope, budget, and stopping condition. Actions that spend money, publish content, contact people, change important data, or otherwise have external consequences should require Kars's approval until he deliberately configures a narrower policy. The system should report failures rather than silently pretending work succeeded.

## Information boundaries

The `Entropy` project is for source code and shareable product/engineering material. Personal or sensitive business notes can live in the separate `Entropy_chatGPT` workspace. Entropy should only bring that private context into a workflow when Kars chooses to connect or provide it; private notes must not accidentally become public project content.

## Delivery direction

The vision is intentionally broader than the first release. Build a small useful core first, then add capabilities when they support Kars's real work and can be demonstrated clearly. Avoid building a large multi-agent platform before a simple end-to-end workflow is useful.

The first product can grow into a workspace where Kars can talk to Entropy, maintain persistent projects and tasks, and inspect delegated work. The exact first workflow and technical stack remain open decisions.

## Current priorities

1. Begin Entropy as a real project and turn this charter into concrete, reviewable increments.
2. Keep Kars's near-term job search important; Entropy may support it when useful, but implementation should not silently displace that goal.
3. Over the next few months, build toward dependable background work and a compelling public demonstration.
4. Explore income-generating uses only after there is a reliable, useful product core.

## Decisions still open

- The first user workflow and minimum useful release.
- Model provider(s), API budget, and provider-switching strategy.
- Local versus hosted deployment and the requirements for overnight work.
- How project memory is stored, searched, corrected, and backed up.
- Which tools Entropy can use and which actions require approval.
- Interface framework, backend framework, database, and agent communication protocol.
