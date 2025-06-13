/*
  JSCodeShift transform: remove console.log(...) statements entirely.
  Keeps console.error and console.warn (to be migrated manually).
*/

module.exports = function (fileInfo, api) {
  const j = api.jscodeshift;
  const root = j(fileInfo.source);

  // Match console.log call expressions and remove them.
  root
    .find(j.CallExpression, {
      callee: {
        type: 'MemberExpression',
        object: { name: 'console' },
        property: { name: name => ['log', 'info', 'debug'].includes(name) },
      },
    })
    .forEach((path) => {
      // Delete the entire expression statement (parent) if it is an ExpressionStatement
      if (path.parent.node.type === 'ExpressionStatement') {
        j(path.parent).remove();
      } else {
        // Otherwise, replace with undefined to preserve structure
        j(path).replaceWith(j.identifier('undefined'));
      }
    });

  return root.toSource({ quote: 'single', trailingComma: true });
}; 