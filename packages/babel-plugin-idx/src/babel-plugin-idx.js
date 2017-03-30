/**
 * Copyright (c) 2013-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */

'use strict'; // eslint-disable-line strict

module.exports = context => {
  const t = context.types;

  const idxRe = /\bidx\b/;

  class TransformedTernary {
    constructor(expression, generateUid) {
      this.generateUid = generateUid;

      this.uids = [];
      this.expression = expression;
      this.deepestTernary = null;
      this.deepestExpression = expression;
    }

    constructTernary(oldExpression, newExpression, uid) {
      return t.ConditionalExpression(
        t.BinaryExpression(
          '!=',
          t.AssignmentExpression('=', t.Identifier(uid), oldExpression),
          t.NullLiteral(),
        ),
        newExpression,
        t.Identifier(uid),
      );
    }

    addLevel(expression, uid) {
      const ternary = this.constructTernary(
        this.deepestExpression,
        expression,
        uid,
      );
      if (this.deepestTernary === null) {
        this.expression = ternary;
      } else {
        this.deepestTernary.consequent = ternary;
      }
      this.deepestTernary = ternary;
      this.deepestExpression = expression;
    }

    appendMethodCall(args) {
      const uid = this.generateUid('ref').name;
      const callExpression = t.CallExpression(
        t.Identifier(uid),
        args || [],
      );
      this.addLevel(callExpression, uid);
      this.uids.push(uid);
    }

    appendPropertyAccess(property, computed) {
      const uid = this.generateUid('ref').name;
      const accessedProperty = t.MemberExpression(
        t.Identifier(uid),
        property,
        computed,
      );
      this.addLevel(accessedProperty, uid);
      this.uids.push(uid);
    }
  }

  function checkIdxArguments(file, node) {
    const args = node.arguments;
    if (args.length !== 2) {
      throw file.buildCodeFrameError(
        node,
        'The `idx` function takes exactly two arguments.',
      );
    }
    const arrowFunction = args[1];
    if (!t.isArrowFunctionExpression(arrowFunction)) {
      throw file.buildCodeFrameError(
        arrowFunction,
        'The second argument supplied to `idx` must be an arrow function.',
      );
    }
    if (!t.isExpression(arrowFunction.body)) {
      throw file.buildCodeFrameError(
        arrowFunction.body,
        'The body of the arrow function supplied to `idx` must be a single ' +
        'expression (without curly braces).',
      );
    }
    if (arrowFunction.params.length !== 1) {
      throw file.buildCodeFrameError(
        arrowFunction.params[2] || arrowFunction,
        'The arrow function supplied to `idx` must take exactly one parameter.',
      );
    }
    const bodyChainBase = getExpressionChainBase(arrowFunction.body);
    if (!t.isIdentifier(arrowFunction.params[0]) ||
        !t.isIdentifier(bodyChainBase) ||
        arrowFunction.params[0].name !== bodyChainBase.name) {
      throw file.buildCodeFrameError(
        arrowFunction.params[0],
        'The parameter of the arrow function supplied to `idx` must match ' +
        'the base of the body expression.',
      );
    }
  }

  function getExpressionChainBase(node) {
    if (t.isCallExpression(node)) {
      return getExpressionChainBase(node.callee);
    } else if (t.isMemberExpression(node)) {
      return getExpressionChainBase(node.object);
    } else {
      return node;
    }
  }

  function isIdxCall(node) {
    return (
      t.isCallExpression(node) &&
      t.isIdentifier(node.callee) &&
      node.callee.name === 'idx'
    );
  }

  function constructTernary(base, node, generateUid) {
    if (t.isCallExpression(node)) {
      const transformedObject = constructTernary(
        base,
        node.callee,
        generateUid,
      );
      transformedObject.appendMethodCall(node.arguments);
      return transformedObject;
    } else if (t.isMemberExpression(node)) {
      const transformedObject = constructTernary(
        base,
        node.object,
        generateUid,
      );
      transformedObject.appendPropertyAccess(node.property, node.computed);
      return transformedObject;
    } else {
      return new TransformedTernary(base, generateUid);
    }
  }

  const idxVisitor = {
    CallExpression(path, state) {
      const node = path.node;
      if (isIdxCall(node)) {
        checkIdxArguments(state.file, node);
        const ternary = constructTernary(
          node.arguments[0],
          node.arguments[1].body,
          path.scope.generateUidIdentifier.bind(path.scope),
        );
        path.replaceWith(ternary.expression);
        for (let ii = 0; ii < ternary.uids.length; ii++) {
          const uid = ternary.uids[ii];
          path.scope.push({id: t.Identifier(uid)});
        }
      }
    },
  };

  return {
    visitor: {
      Program(path, state) {
        // If there can't reasonably be an idx call, exit fast.
        if (path.scope.getOwnBinding('idx') || idxRe.test(state.file.code)) {
          // We're very strict about the shape of idx. Some transforms, like
          // "babel-plugin-transform-async-to-generator", will convert arrow
          // functions inside async functions into regular functions. So we do
          // our transformation before any one else interferes.
          path.traverse(idxVisitor, state);
        }
      },
    },
  };
};
