const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const sourcePath = path.join(__dirname, "..", "src", "workspace-navigation.ts");
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleRecord = { exports: {} };
const runModule = vm.runInThisContext(`(function (exports, require, module) { ${compiled}\n})`, {
  filename: sourcePath,
});
runModule(moduleRecord.exports, require, moduleRecord);

const {
  createWorkspaceHistoryState,
  hashForRoute,
  isActiveWorkspaceRequest,
  restoreWorkspaceHistoryState,
  routeFromHash,
  shouldLoadConversationTranscript,
  shouldPushWorkspaceHistory,
  workspaceDocumentTitle,
} = moduleRecord.exports;

assert.equal(routeFromHash("#applications"), "applications");
assert.equal(routeFromHash("#unknown"), "chat");
assert.equal(hashForRoute("memory"), "#memory");
assert.equal(shouldLoadConversationTranscript("chat"), true);
assert.equal(shouldLoadConversationTranscript("career"), true);
assert.equal(shouldLoadConversationTranscript("applications"), false);
assert.equal(shouldLoadConversationTranscript("tasks"), false);
assert.equal(shouldLoadConversationTranscript("memory"), false);
assert.equal(workspaceDocumentTitle("general", true, null, null), "Новый диалог");
assert.equal(workspaceDocumentTitle("career", true, "career-draft", null), "Новый разбор");
assert.equal(workspaceDocumentTitle("career", false, "career-1", null), "Сохранённый разбор");
assert.equal(workspaceDocumentTitle("general", false, "general-1", "Проект Entropy"), "Проект Entropy");
assert.equal(workspaceDocumentTitle("general", false, "general-1", "Проект Entropy", "tasks"), "Задачи Veltrics");
assert.equal(workspaceDocumentTitle("general", false, "general-1", "Проект Entropy", "applications"), "Отклики");

const saved = {
  workspace: "general",
  generalConversationId: "general-1",
  careerConversationId: "career-1",
};
const applicationState = createWorkspaceHistoryState("applications", "career", "career-1", null);
assert.deepEqual(restoreWorkspaceHistoryState(applicationState, "#applications", saved), applicationState);
assert.equal(shouldPushWorkspaceHistory("http://localhost/#applications", "#applications", applicationState, applicationState), false);
assert.equal(shouldPushWorkspaceHistory("http://localhost/#applications", "#applications", null, applicationState), true);
const incompleteState = { ...applicationState, rootLanding: undefined };
assert.equal(restoreWorkspaceHistoryState(incompleteState, "#applications", saved).conversationId, "career-1");
const taskState = createWorkspaceHistoryState("tasks", "career", "career-1", "task-7");
assert.deepEqual(restoreWorkspaceHistoryState(taskState, "#tasks", saved), taskState);
assert.equal(shouldPushWorkspaceHistory("http://localhost/#applications", "#tasks", applicationState, taskState), true);
assert.equal(isActiveWorkspaceRequest(
  { workspace: "general", route: "chat", conversationId: null, epoch: 3 },
  { workspace: "general", route: "chat", conversationId: null, epoch: 3 },
  "general-created-after-send",
), true);
assert.equal(isActiveWorkspaceRequest(
  { workspace: "general", route: "tasks", conversationId: "general-1", epoch: 4 },
  { workspace: "general", route: "chat", conversationId: "general-1", epoch: 3 },
), false);
assert.equal(isActiveWorkspaceRequest(
  { workspace: "career", route: "career", conversationId: null, epoch: 3 },
  { workspace: "general", route: "chat", conversationId: null, epoch: 3 },
), false);
assert.equal(isActiveWorkspaceRequest(
  { workspace: "general", route: "chat", conversationId: null, epoch: 4 },
  { workspace: "general", route: "chat", conversationId: null, epoch: 3 },
), false);

const staleState = createWorkspaceHistoryState("applications", "career", "career-1", null);
const fallback = restoreWorkspaceHistoryState(staleState, "#chat", saved);
assert.equal(fallback.route, "chat");
assert.equal(fallback.workspace, "general");
assert.equal(fallback.conversationId, "general-1");
assert.equal(fallback.selectedTaskId, null);

const mismatchedState = createWorkspaceHistoryState("chat", "career", "career-1", null);
const normalized = restoreWorkspaceHistoryState(mismatchedState, "#chat", saved);
assert.equal(normalized.workspace, "general");
assert.equal(normalized.conversationId, "general-1");

const appPath = path.join(__dirname, "..", "src", "App.tsx");
const appSource = ts.createSourceFile(
  appPath,
  fs.readFileSync(appPath, "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let trackerShortcutHandler;
function findTrackerShortcut(node) {
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(appSource) === "button") {
    const attributes = node.openingElement.attributes.properties.filter(ts.isJsxAttribute);
    const className = attributes.find((attribute) => attribute.name.getText(appSource) === "className");
    const classValue = className?.initializer;
    if (classValue && ts.isStringLiteral(classValue) && classValue.text === "career-tracker-shortcut") {
      const onClick = attributes.find((attribute) => attribute.name.getText(appSource) === "onClick");
      if (onClick?.initializer && ts.isJsxExpression(onClick.initializer)) {
        trackerShortcutHandler = onClick.initializer.expression;
      }
    }
  }
  ts.forEachChild(node, findTrackerShortcut);
}
findTrackerShortcut(appSource);
assert.ok(ts.isArrowFunction(trackerShortcutHandler), "Career tracker shortcut must wrap navigation in an arrow function.");
assert.equal(trackerShortcutHandler.parameters.length, 0, "React click events must not be passed as tracker IDs.");
assert.ok(ts.isCallExpression(trackerShortcutHandler.body), "Career tracker shortcut must call its navigation callback.");
assert.equal(trackerShortcutHandler.body.expression.getText(appSource), "onOpenTracker");
assert.equal(trackerShortcutHandler.body.arguments.length, 0);
const applicationHandlers = new Map();
function collectApplicationHandlers(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
    if (["openApplications", "openApplicationsForConversation"].includes(node.name.text)) {
      applicationHandlers.set(node.name.text, node.initializer);
    }
  }
  ts.forEachChild(node, collectApplicationHandlers);
}
collectApplicationHandlers(appSource);
assert.ok(ts.isArrowFunction(applicationHandlers.get("openApplications")));
assert.equal(applicationHandlers.get("openApplications").parameters.length, 0);
assert.ok(ts.isArrowFunction(applicationHandlers.get("openApplicationsForConversation")));
assert.equal(applicationHandlers.get("openApplicationsForConversation").parameters.length, 1);

let activityComposerHandler;
function findActivityComposerHandler(node) {
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(appSource) === "button") {
    const attributes = node.openingElement.attributes.properties.filter(ts.isJsxAttribute);
    const onClick = attributes.find((attribute) => attribute.name.getText(appSource) === "onClick");
    if (onClick?.initializer && ts.isJsxExpression(onClick.initializer)
      && onClick.initializer.expression?.getText(appSource) === "openActivityComposer") {
      activityComposerHandler = onClick.initializer.expression;
    }
  }
  ts.forEachChild(node, findActivityComposerHandler);
}
findActivityComposerHandler(appSource);
assert.ok(activityComposerHandler, "The activity panel CTA must use its navigation handler.");
const activityComposer = appSource.statements
  .flatMap((statement) => statement.body ? [statement.body] : [])
  .flatMap((body) => body.statements || [])
  .flatMap((statement) => statement.declarationList?.declarations || [])
  .find((declaration) => declaration.name.getText(appSource) === "openActivityComposer")?.initializer;
assert.ok(ts.isArrowFunction(activityComposer), "The activity composer handler must be a named function.");
const activityComposerSource = activityComposer.getText(appSource);
assert.match(activityComposerSource, /leaveApplications\(\)/, "The CTA must leave the tracker before focusing the composer.");
assert.match(activityComposerSource, /requestAnimationFrame/, "The CTA must focus after the conversation view renders.");
assert.match(activityComposerSource, /input\.focus\(\)/, "The CTA must focus the visible message field.");
assert.match(activityComposerSource, /setDraft\(/, "The career CTA must offer a starter prompt when the draft is empty.");

console.log("PASS: browser history restores each workspace route and falls back to the saved conversation for stale entries.");
