const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const sourceDirectory = path.join(__dirname, "..", "src");
const issues = [];
let buttonsChecked = 0;
let linksChecked = 0;
let formControlsChecked = 0;
const labelTargets = new Set();

function collectTsxFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectTsxFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".tsx") ? [entryPath] : [];
  });
}

function hasAttribute(node, name) {
  return node.attributes.properties.some((property) =>
    ts.isJsxAttribute(property) && property.name.getText() === name,
  );
}

function stringAttribute(node, name) {
  const attribute = node.attributes.properties.find((property) =>
    ts.isJsxAttribute(property) && property.name.getText() === name,
  );
  if (!attribute?.initializer) return undefined;
  const value = ts.isJsxExpression(attribute.initializer)
    ? attribute.initializer.expression
    : attribute.initializer;
  return ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)
    ? value.text
    : undefined;
}

function expressionAttribute(node, name) {
  const attribute = node.attributes.properties.find((property) =>
    ts.isJsxAttribute(property) && property.name.getText() === name,
  );
  if (!attribute?.initializer) return undefined;
  return ts.isJsxExpression(attribute.initializer)
    ? attribute.initializer.expression
    : attribute.initializer;
}

function attributeText(node, name, sourceFile) {
  const attribute = node.attributes.properties.find((property) =>
    ts.isJsxAttribute(property) && property.name.getText() === name,
  );
  if (!attribute?.initializer) return undefined;
  if (ts.isJsxExpression(attribute.initializer)) {
    return attribute.initializer.expression?.getText(sourceFile);
  }
  return ts.isStringLiteral(attribute.initializer) ? attribute.initializer.text : undefined;
}

function expressionHasText(expression) {
  if (!expression) return false;
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return Boolean(expression.text.trim());
  }
  if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    return true;
  }
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)) {
    return expressionHasText(expression.expression);
  }
  if (ts.isConditionalExpression(expression)) {
    return expressionHasText(expression.whenTrue) || expressionHasText(expression.whenFalse);
  }
  if (ts.isBinaryExpression(expression)) {
    if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return expressionHasText(expression.right);
    }
    return expressionHasText(expression.left) || expressionHasText(expression.right);
  }
  if (ts.isTemplateExpression(expression)) {
    return Boolean(expression.head.text.trim())
      || expression.templateSpans.some((span) => Boolean(span.literal.text.trim()));
  }
  if (ts.isJsxElement(expression)) return hasTextContent(expression.children);
  if (ts.isJsxFragment(expression)) return hasTextContent(expression.children);
  return false;
}

function hasTextContent(nodes) {
  return nodes.some((node) => {
    if (ts.isJsxText(node)) return Boolean(node.text.trim());
    if (ts.isJsxExpression(node)) return expressionHasText(node.expression);
    if (ts.isJsxElement(node)) return hasTextContent(node.children);
    if (ts.isJsxSelfClosingElement(node)) return false;
    if (ts.isJsxFragment(node)) return hasTextContent(node.children);
    return false;
  });
}

function hasMeaningfulNameAttribute(node, name) {
  const value = expressionAttribute(node, name);
  if (!value || isNoopExpression(value)) return false;
  return !(
    (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))
    && !value.text.trim()
  );
}

function hasAccessibleName(node, children = []) {
  if (hasMeaningfulNameAttribute(node, "aria-label")) return true;
  if (hasMeaningfulNameAttribute(node, "aria-labelledby")) return true;
  if (hasMeaningfulNameAttribute(node, "title")) return true;
  return hasTextContent(children);
}

function hasFormControlName(node, sourceFile, insideNamedLabel) {
  if (hasMeaningfulNameAttribute(node, "aria-label")) return true;
  if (hasMeaningfulNameAttribute(node, "aria-labelledby")) return true;
  if (insideNamedLabel) return true;
  const id = attributeText(node, "id", sourceFile);
  return Boolean(id && labelTargets.has(id));
}

function collectLabelTargets(node, sourceFile) {
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(sourceFile) === "label") {
    const target = attributeText(node.openingElement, "htmlFor", sourceFile);
    if (target) labelTargets.add(target);
  } else if (
    ts.isJsxSelfClosingElement(node)
    && node.tagName.getText(sourceFile) === "label"
  ) {
    const target = attributeText(node, "htmlFor", sourceFile);
    if (target) labelTargets.add(target);
  }
  ts.forEachChild(node, (child) => collectLabelTargets(child, sourceFile));
}

function isNoopExpression(expression) {
  if (!expression) return true;
  if (ts.isParenthesizedExpression(expression)) return isNoopExpression(expression.expression);
  if (ts.isVoidExpression(expression)) return isNoopExpression(expression.expression);
  if (expression.kind === ts.SyntaxKind.NullKeyword || expression.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (ts.isIdentifier(expression) && expression.text === "undefined") return true;

  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
    const { body } = expression;
    if (!ts.isBlock(body)) return isNoopExpression(body);
    return body.statements.length === 0 || body.statements.every((statement) =>
      ts.isReturnStatement(statement) && isNoopExpression(statement.expression),
    );
  }

  return false;
}

function verifyNoopDetector() {
  const examples = [
    ["() => {}", true],
    ["() => undefined", true],
    ["() => { return; }", true],
    ["() => saveApplication()", false],
    ["handleClick", false],
  ];

  for (const [source, expected] of examples) {
    const fixture = ts.createSourceFile(
      "interaction-handler.tsx",
      `const handler = ${source};`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const handler = fixture.statements[0]?.declarationList?.declarations[0]?.initializer;
    if (isNoopExpression(handler) !== expected) {
      throw new Error(`Interaction audit self-check failed for ${source}`);
    }
  }
}

function visitSource(node, sourceFile, filePath, activeForms = [], insideNamedLabel = false) {
  if (ts.isJsxElement(node)) {
    const opening = node.openingElement;
    const tagName = opening.tagName.getText(sourceFile);
    const childInsideNamedLabel = insideNamedLabel
      || (tagName === "label" && hasTextContent(node.children));
    inspectOpening(opening, sourceFile, filePath, activeForms, node.children, insideNamedLabel);
    const childForms = tagName === "form"
      ? [...activeForms, hasAttribute(opening, "onSubmit")]
      : activeForms;
    node.children.forEach((child) => visitSource(
      child,
      sourceFile,
      filePath,
      childForms,
      childInsideNamedLabel,
    ));
    return;
  }

  if (ts.isJsxSelfClosingElement(node)) {
    inspectOpening(node, sourceFile, filePath, activeForms, [], insideNamedLabel);
    return;
  }

  if (ts.isJsxFragment(node)) {
    node.children.forEach((child) => visitSource(
      child,
      sourceFile,
      filePath,
      activeForms,
      insideNamedLabel,
    ));
    return;
  }

  ts.forEachChild(node, (child) => visitSource(
    child,
    sourceFile,
    filePath,
    activeForms,
    insideNamedLabel,
  ));
}

function inspectOpening(node, sourceFile, filePath, activeForms, children = [], insideNamedLabel = false) {
  const tagName = node.tagName.getText(sourceFile);
  const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const label = `${path.relative(process.cwd(), filePath)}:${location.line + 1}`;

  if (tagName === "button") {
    buttonsChecked += 1;
    const type = stringAttribute(node, "type");
    if (activeForms.length > 0 && type === undefined) {
      issues.push(`${label}: button inside a form must declare its type`);
    }
    const submitsThroughForm = activeForms.some(Boolean) && (!type || type === "submit");
    if (!hasAttribute(node, "onClick") && !submitsThroughForm) {
      issues.push(`${label}: button has no click handler or submit form`);
    }
    if (hasAttribute(node, "onClick") && isNoopExpression(expressionAttribute(node, "onClick"))) {
      issues.push(`${label}: button has an empty click handler`);
    }
    if (!hasAccessibleName(node, children)) {
      issues.push(`${label}: button has no accessible name`);
    }
  }

  if (tagName === "a") {
    linksChecked += 1;
    if (!hasAttribute(node, "href")) issues.push(`${label}: anchor has no href`);
    const href = stringAttribute(node, "href")?.trim();
    if (href !== undefined && (href === "" || href === "#")) {
      issues.push(`${label}: anchor has an empty or placeholder href`);
    }
  }

  if (["input", "select", "textarea"].includes(tagName)) {
    formControlsChecked += 1;
    if (!hasFormControlName(node, sourceFile, insideNamedLabel)) {
      issues.push(`${label}: ${tagName} has no accessible label`);
    }
  }

  if (["div", "span", "li", "section", "article"].includes(tagName) && hasAttribute(node, "onClick")) {
    const role = stringAttribute(node, "role");
    const keyboardHandler = hasAttribute(node, "onKeyDown") || hasAttribute(node, "onKeyUp");
    if (!role || !hasAttribute(node, "tabIndex") || !keyboardHandler) {
      issues.push(`${label}: clickable ${tagName} needs keyboard interaction semantics`);
    }
  }
}

function verifyAccessibleNameDetector() {
  const fixture = ts.createSourceFile(
    "accessible-name-fixture.tsx",
    `const fixture = (label: string, selected: boolean) => <>
      <button><Icon /></button>
      <button aria-label="Close" />
      <button>{selected ? "Open" : label}</button>
      <button title={undefined}><Icon /></button>
    </>;`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const buttons = [];
  const collect = (node) => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(fixture) === "button") {
      buttons.push({ openingElement: node.openingElement, children: node.children });
    } else if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(fixture) === "button") {
      buttons.push({ openingElement: node, children: [] });
    }
    ts.forEachChild(node, collect);
  };
  collect(fixture);
  const expected = [false, true, true, false];
  if (buttons.length !== expected.length || buttons.some((button, index) =>
    hasAccessibleName(button.openingElement, button.children) !== expected[index],
  )) {
    throw new Error(`Accessible-name audit self-check failed: ${buttons.map((button) => hasAccessibleName(button.openingElement, button.children)).join(",")}`);
  }
}

function verifyStringAttributeDetector() {
  const fixture = ts.createSourceFile(
    "string-attribute-fixture.tsx",
    `const fixture = <>
      <a href="#">literal</a>
      <a href={"#"}>expression placeholder</a>
      <a href={""}>empty expression</a>
      <a href={"/chat"}>route expression</a>
    </>;`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const anchors = [];
  const collect = (node) => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(fixture) === "a") {
      anchors.push(node.openingElement);
    }
    ts.forEachChild(node, collect);
  };
  collect(fixture);
  const expected = ["#", "#", "", "/chat"];
  if (anchors.length !== expected.length || anchors.some((anchor, index) =>
    stringAttribute(anchor, "href") !== expected[index],
  )) {
    throw new Error(`String-attribute audit self-check failed: ${anchors.map((anchor) => stringAttribute(anchor, "href")).join(",")}`);
  }
}

function verifyFormControlNameDetector() {
  const fixture = ts.createSourceFile(
    "form-control-fixture.tsx",
    `const fixture = <>
      <label>Company<input /></label>
      <label htmlFor="status">Status</label><select id="status" />
      <textarea aria-label="Notes" />
      <input placeholder="Not an accessible label" />
    </>;`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const controls = [];
  const visit = (node, insideNamedLabel = false) => {
    if (ts.isJsxElement(node)) {
      const tagName = node.openingElement.tagName.getText(fixture);
      const childIsNamedLabel = insideNamedLabel
        || (tagName === "label" && hasTextContent(node.children));
      if (["input", "select", "textarea"].includes(tagName)) {
        controls.push({ node: node.openingElement, insideNamedLabel });
      }
      node.children.forEach((child) => visit(child, childIsNamedLabel));
      return;
    }
    if (ts.isJsxSelfClosingElement(node)) {
      if (["input", "select", "textarea"].includes(node.tagName.getText(fixture))) {
        controls.push({ node, insideNamedLabel });
      }
      return;
    }
    ts.forEachChild(node, (child) => visit(child, insideNamedLabel));
  };
  collectLabelTargets(fixture, fixture);
  visit(fixture);
  const named = controls.map(({ node, insideNamedLabel }) =>
    hasFormControlName(node, fixture, insideNamedLabel),
  );
  const expected = [true, true, true, false];
  if (named.length !== expected.length || named.some((value, index) => value !== expected[index])) {
    throw new Error(`Form-control label audit self-check failed: ${named.join(",")}`);
  }
  labelTargets.clear();
}

verifyNoopDetector();
verifyAccessibleNameDetector();
verifyStringAttributeDetector();
verifyFormControlNameDetector();

const files = collectTsxFiles(sourceDirectory);
for (const filePath of files) {
  const source = fs.readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  labelTargets.clear();
  collectLabelTargets(sourceFile, sourceFile);
  visitSource(sourceFile, sourceFile, filePath);
}

if (issues.length) {
  console.error(issues.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`PASS: ${files.length} TSX files, ${buttonsChecked} buttons, ${linksChecked} anchors, ${formControlsChecked} labelled form controls.`);
}
