# Entropy — first useful release (proposal)

**Status:** first workflow approved; technical decisions remain open  
**Date:** 14 October 2026

## The first end-to-end promise

Kars can open Entropy, ask for help on an ongoing project, see what Entropy is doing, and return later to find the conversation, task, and result still there.

This establishes the core loop: **talk → plan → do bounded work → report → remember**.

## First release scope

### 1. A personal workspace

- A responsive web interface that runs locally during development and is comfortable to use as the primary Entropy window.
- A chat with Entropy as the default entry point.
- A small workspace view for projects, open tasks, and completed results.
- Persistent conversation and task records so closing the browser does not erase work.

### 2. One orchestrator, one developer capability

- Entropy accepts a request, asks a focused follow-up when needed, and turns the request into a bounded task.
- Entropy can delegate a coding task to a Veltrics developer capability and return its summary and references to changed files.
- Agent names and responsibilities are represented as configuration so Ophira and Psyche can be added later without redesigning the user experience.
- Initially, delegation can be explicit and simple. The goal is a working handoff, not a complex autonomous agent network.

### 3. Visible task progress

- Every task has an owner, status, created time, and result.
- Kars can distinguish queued, running, waiting for input, completed, and failed work.
- Entropy reports what it attempted, what it produced, and what needs Kars's attention.

### 4. Memory with clear boundaries

- Keep project instructions and decisions in durable, readable files or records.
- Let Kars choose which project context is available to a task.
- Keep personal and sensitive business notes in the separate `Entropy_chatGPT` workspace unless Kars explicitly connects selected material.
- Make stored context reviewable and correctable; do not claim complete or automatic knowledge of every chat or file.

### 5. Bounded background work

- A task can continue after the browser is closed as long as the Entropy service and worker remain running.
- A local Windows development instance stops when the computer is shut down or asleep. Dependable overnight work requires hosting the worker on an always-on machine or cloud service.
- Start with work that has a clear goal and stopping condition. External actions such as publishing, contacting people, or spending money remain behind a human approval step.

## Recommended implementation sequence

1. **Foundation:** agree on the first workflow, choose the stack, configure the model through a replaceable provider interface, and create a runnable local app.
2. **Conversation:** implement Entropy chat with stored conversations and project context.
3. **Task loop:** create tasks, show status and progress, save results, and support a user follow-up.
4. **Developer handoff:** let Entropy package a bounded coding request for Veltrics and present the returned work clearly.
5. **Background execution:** add a worker that can resume queued work and record errors and completion.
6. **Deployment:** only after the local workflow is useful, choose an always-on deployment for overnight tasks.

## Current prototype

The repository contains a standard-library Python web server, a responsive local workspace, SQLite persistence, a background task queue, a deterministic demo provider, and an optional OpenAI Responses API provider. Demo mode is the default. In live mode Entropy makes one call to answer and decide whether to delegate; delegated work adds a Veltrics call. The two roles have separate model and output-token settings, but currently share the same API provider by default. Neither role has repository-reading or file-changing tools yet.

The live provider is opt-in through PyCharm environment variables. Both roles receive curated project rules, the charter and MVP brief, a short learning-state summary, and up to 12 previous messages from the same conversation; Veltrics also receives Entropy's plan. The main dialogue is Kars ↔ Entropy; Veltrics's full task result belongs in a separate task detail view. A real Veltrics coding handoff will need an explicitly scoped tool runner and a reviewable change proposal before it can modify project files.

## Deliberately postponed

- Multiple autonomous agents collaborating with each other.
- Broad access to the computer or external accounts.
- Unattended actions that publish, message people, or spend money.
- Income generation as a feature claim before a concrete business workflow is validated.
- A large memory/search infrastructure before there is enough real project knowledge to justify it.

## Boundary for the short video demo

- The storefront belongs inside a Telegram Mini App; it is not a page in the Entropy web workspace.
- Entropy remains the primary product and brand. Argus is its observability module for workflow runs, agent activity, progress, and failures; Argus is not an agent or orchestrator.
- n8n may be shown as the workflow engine for the demo. Treat a flow as live only after it is connected; simulated events must be labeled as demo data.
- This presentation direction does not replace the first-release promise above or make Telegram commerce part of the core MVP.

## Decisions to make before scaffolding

- First workflow: what should Kars be able to accomplish in a five-minute demo?
- Interface: local-first web app is the current recommendation; confirm whether desktop-style presentation or mobile use is essential at the start.
- Stack: Python backend is the current recommendation, consistent with Kars's experience; choose frontend and persistence with the first workflow in mind.
- Model and budget: select an API model and set a usage ceiling before making live calls.
- Coding handoff: decide whether Veltrics initially works only through this Codex collaboration or whether the first release should call a separate coding agent.
