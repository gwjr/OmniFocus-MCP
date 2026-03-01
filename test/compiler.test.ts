import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileWhere, CompileError, escapeJxaString } from '../dist/tools/query/backends/jxaCompiler.js';

// Helper to compile and get the condition string
function compile(where: unknown, entity: 'tasks' | 'projects' | 'folders' = 'tasks') {
  return compileWhere(where, entity);
}

describe('escapeJxaString', () => {
  it('escapes backslashes', () => {
    assert.equal(escapeJxaString('a\\b'), 'a\\\\b');
  });

  it('escapes double quotes', () => {
    assert.equal(escapeJxaString('he said "hi"'), 'he said \\"hi\\"');
  });

  it('escapes newlines and tabs', () => {
    assert.equal(escapeJxaString('a\nb\tc'), 'a\\nb\\tc');
  });

  it('handles empty string', () => {
    assert.equal(escapeJxaString(''), '');
  });
});

describe('literals', () => {
  it('compiles string literals', () => {
    const r = compile('hello');
    assert.equal(r.condition, '"hello"');
  });

  it('compiles number literals', () => {
    const r = compile(42);
    assert.equal(r.condition, '42');
  });

  it('compiles boolean literals', () => {
    assert.equal(compile(true).condition, 'true');
    assert.equal(compile(false).condition, 'false');
  });

  it('compiles null literals', () => {
    assert.equal(compile(null).condition, 'null');
  });

  it('compiles array literals', () => {
    const r = compile([1, 'a', true]);
    assert.equal(r.condition, '[1,"a",true]');
  });
});

describe('date literals (compact syntax)', () => {
  it('compiles {date: "2026-03-01"} to a preamble date var', () => {
    const r = compile({ date: '2026-03-01' });
    assert.match(r.condition, /^_d\d+$/);
    assert.equal(r.preamble.length, 1);
    assert.match(r.preamble[0], /new Date\("2026-03-01"\)/);
  });

  it('rejects non-string date value', () => {
    assert.throws(() => compile({ date: 42 }), CompileError);
  });
});

describe('variable references', () => {
  it('compiles task vars', () => {
    const r = compile({ var: 'name' }, 'tasks');
    assert.equal(r.condition, '(item.name || "")');
  });

  it('compiles project vars', () => {
    const r = compile({ var: 'status' }, 'projects');
    assert.equal(r.condition, 'projectStatusMap[item.status]');
  });

  it('compiles folder vars', () => {
    const r = compile({ var: 'name' }, 'folders');
    assert.equal(r.condition, '(item.name || "")');
  });

  it('compiles {var: "now"} to _now', () => {
    const r = compile({ var: 'now' }, 'tasks');
    assert.equal(r.condition, '_now');
  });

  it('compiles {var: "tags"} to lowercased tag array', () => {
    const r = compile({ var: 'tags' }, 'tasks');
    assert.match(r.condition, /tags\.map/);
    assert.match(r.condition, /toLowerCase/);
  });

  it('rejects unknown variable with suggestion for folderName', () => {
    try {
      compile({ var: 'folderName' }, 'tasks');
      assert.fail('Expected CompileError');
    } catch (e) {
      assert.ok(e instanceof CompileError);
      assert.match(e.message, /container/);
    }
  });

  it('rejects unknown variable with available vars list', () => {
    try {
      compile({ var: 'bogus' }, 'tasks');
      assert.fail('Expected CompileError');
    } catch (e) {
      assert.ok(e instanceof CompileError);
      assert.match(e.message, /Available vars:/);
      assert.match(e.message, /name/);
    }
  });
});

describe('logical operations (compact syntax)', () => {
  it('compiles and', () => {
    const r = compile({ and: [true, false] });
    assert.equal(r.condition, '(true && false)');
  });

  it('compiles or with 3 args', () => {
    const r = compile({ or: [true, false, true] });
    assert.equal(r.condition, '(true || false || true)');
  });

  it('compiles not', () => {
    const r = compile({ not: [true] });
    assert.equal(r.condition, '(!(true))');
  });

  it('rejects and with < 2 args', () => {
    assert.throws(() => compile({ and: [true] }), CompileError);
  });

  it('rejects not with != 1 arg', () => {
    assert.throws(() => compile({ not: [true, false] }), CompileError);
  });
});

describe('comparison operations (compact syntax)', () => {
  it('compiles eq with _eq helper', () => {
    const r = compile({ eq: [{ var: 'status' }, 'Active'] });
    assert.match(r.condition, /^_eq\(taskStatusMap\[item\.taskStatus\],"Active"\)$/);
  });

  it('compiles neq', () => {
    const r = compile({ neq: [{ var: 'name' }, 'test'] });
    assert.match(r.condition, /!_eq\(/);
  });

  it('compiles gt with null guards', () => {
    const r = compile({ gt: [{ var: 'estimatedMinutes' }, 30] });
    assert.match(r.condition, /!= null/);
    assert.match(r.condition, />/);
  });

  it('compiles lt', () => {
    const r = compile({ lt: [{ var: 'estimatedMinutes' }, 60] });
    assert.match(r.condition, /< 60/);
  });

  it('compiles eq with null (replaces isNull)', () => {
    const r = compile({ eq: [{ var: 'dueDate' }, null] });
    assert.match(r.condition, /_eq\(.*,null\)/);
  });

  it('compiles eq with boolean (replaces isTrue/isFalse)', () => {
    const r = compile({ eq: [{ var: 'flagged' }, true] });
    assert.match(r.condition, /_eq\(.*,true\)/);
  });
});

describe('value-in-array (compact syntax)', () => {
  it('compiles value in array', () => {
    const r = compile({ in: [{ var: 'status' }, ['Available', 'Next']] });
    assert.match(r.condition, /indexOf/);
    assert.match(r.condition, /"Available"/);
    assert.match(r.condition, /"Next"/);
  });

  it('rejects non-array second arg', () => {
    assert.throws(() => compile({ in: [{ var: 'status' }, 'Active'] }), CompileError);
  });
});

describe('string operations (compact syntax)', () => {
  it('compiles contains (case-insensitive)', () => {
    const r = compile({ contains: [{ var: 'name' }, 'Review'] });
    assert.match(r.condition, /toLowerCase\(\)\.indexOf\("review"\)/);
  });

  it('compiles startsWith', () => {
    const r = compile({ startsWith: [{ var: 'name' }, 'Task'] });
    assert.match(r.condition, /toLowerCase\(\)\.lastIndexOf\("task",0\)/);
  });

  it('compiles endsWith', () => {
    const r = compile({ endsWith: [{ var: 'name' }, 'done'] });
    assert.match(r.condition, /toLowerCase/);
    assert.match(r.condition, /indexOf/);
  });

  it('compiles matches with regex', () => {
    const r = compile({ matches: [{ var: 'name' }, '^Review.*'] });
    assert.match(r.condition, /test/);
    assert.equal(r.preamble.length, 1);
    assert.match(r.preamble[0], /new RegExp/);
    assert.match(r.preamble[0], /"i"/);
  });

  it('rejects matches with non-string pattern', () => {
    assert.throws(() => compile({ matches: [{ var: 'name' }, 42] }), CompileError);
  });
});

describe('polymorphic contains (tags)', () => {
  it('compiles array contains for tags var', () => {
    const r = compile({ contains: [{ var: 'tags' }, 'work'] });
    // Should use array indexOf, not string indexOf with toLowerCase
    assert.match(r.condition, /\.indexOf\("work"\) !== -1/);
    // Should NOT have .toLowerCase() on left side (array is already lowered)
    assert.doesNotMatch(r.condition, /toLowerCase\(\)\.indexOf/);
  });

  it('compiles string contains for name var', () => {
    const r = compile({ contains: [{ var: 'name' }, 'test'] });
    // Should use string toLowerCase().indexOf
    assert.match(r.condition, /toLowerCase\(\)\.indexOf\("test"\)/);
  });
});

describe('offset (compact syntax)', () => {
  it('compiles offset from now with negative days', () => {
    const r = compile({ offset: { date: 'now', days: -3 } });
    assert.match(r.condition, /^_d\d+$/);
    assert.ok(r.preamble.some(p => p.includes('_now.getTime()') && p.includes('-3')));
  });

  it('compiles offset from now with positive days', () => {
    const r = compile({ offset: { date: 'now', days: 7 } });
    assert.match(r.condition, /^_d\d+$/);
    assert.ok(r.preamble.some(p => p.includes('+7')));
  });

  it('compiles offset from date literal', () => {
    const r = compile({ offset: { date: '2026-03-01', days: 5 } });
    assert.match(r.condition, /^_d\d+$/);
    // Should have date preamble for the literal + the offset
    assert.ok(r.preamble.some(p => p.includes('2026-03-01')));
  });

  it('compiles offset from var', () => {
    const r = compile({ offset: { date: { var: 'dueDate' }, days: -1 } });
    assert.match(r.condition, /^_d\d+$/);
    assert.ok(r.preamble.some(p => p.includes('dueDate')));
  });

  it('rejects missing date field', () => {
    assert.throws(() => compile({ offset: { days: -3 } }), CompileError);
  });

  it('rejects missing days field', () => {
    assert.throws(() => compile({ offset: { date: 'now' } }), CompileError);
  });

  it('rejects non-integer days', () => {
    assert.throws(() => compile({ offset: { date: 'now', days: 3.5 } }), CompileError);
  });
});

describe('container (container scoping, compact syntax)', () => {
  it('compiles container("project", expr) for tasks', () => {
    const r = compile(
      { container: ['project', { contains: [{ var: 'name' }, 'litigation'] }] },
      'tasks'
    );
    assert.match(r.condition, /containingProject/);
    assert.match(r.condition, /litigation/);
    assert.match(r.condition, /function/);
  });

  it('compiles container("folder", expr) for tasks with chain walk', () => {
    const r = compile(
      { container: ['folder', { eq: [{ var: 'name' }, 'Legal'] }] },
      'tasks'
    );
    assert.match(r.condition, /containingProject/);
    assert.match(r.condition, /parentFolder/);
    assert.match(r.condition, /\.parent/);
    assert.match(r.condition, /while/);
  });

  it('compiles container("folder", expr) for projects', () => {
    const r = compile(
      { container: ['folder', { contains: [{ var: 'name' }, 'Legal'] }] },
      'projects'
    );
    assert.match(r.condition, /parentFolder/);
    assert.match(r.condition, /while/);
  });

  it('compiles container("folder", expr) for folders', () => {
    const r = compile(
      { container: ['folder', { eq: [{ var: 'name' }, 'Root'] }] },
      'folders'
    );
    assert.match(r.condition, /\.parent/);
    assert.match(r.condition, /while/);
  });

  it('rejects container("project") for projects entity', () => {
    assert.throws(
      () => compile({ container: ['project', { eq: [{ var: 'name' }, 'x'] }] }, 'projects'),
      CompileError
    );
  });

  it('rejects container("project") for folders entity', () => {
    assert.throws(
      () => compile({ container: ['project', { eq: [{ var: 'name' }, 'x'] }] }, 'folders'),
      CompileError
    );
  });

  it('compiles container("tag", expr) for tags entity', () => {
    const r = compile(
      { container: ['tag', { contains: [{ var: 'name' }, 'Work'] }] },
      'tags'
    );
    assert.match(r.condition, /\.parent/);
    assert.match(r.condition, /while/);
  });

  it('rejects container("tag") for tasks entity', () => {
    assert.throws(
      () => compile({ container: ['tag', { eq: [{ var: 'name' }, 'x'] }] }, 'tasks'),
      CompileError
    );
  });

  it('rejects container("project") for tags entity', () => {
    assert.throws(
      () => compile({ container: ['project', { eq: [{ var: 'name' }, 'x'] }] }, 'tags'),
      CompileError
    );
  });

  it('rejects container("folder") for tags entity', () => {
    assert.throws(
      () => compile({ container: ['folder', { eq: [{ var: 'name' }, 'x'] }] }, 'tags'),
      CompileError
    );
  });

  it('uses correct var registry inside container', () => {
    const r = compile(
      { container: ['project', { eq: [{ var: 'status' }, 'Active'] }] },
      'tasks'
    );
    // Should use projectStatusMap, not taskStatusMap
    assert.match(r.condition, /projectStatusMap/);
  });
});

describe('between (date range sugar)', () => {
  it('compiles between to gte+lte', () => {
    const r = compile({
      between: [{ var: 'dueDate' }, { var: 'now' }, { offset: { date: 'now', days: 7 } }]
    });
    // Should desugar to (dueDate >= now && dueDate <= offset)
    assert.match(r.condition, /&&/);
    assert.match(r.condition, />=/);
    assert.match(r.condition, /<=/);
    assert.match(r.condition, /dueDate/);
  });

  it('compiles between with date literals', () => {
    const r = compile({
      between: [{ var: 'dueDate' }, { date: '2026-01-01' }, { date: '2026-12-31' }]
    });
    assert.match(r.condition, />=/);
    assert.match(r.condition, /<=/);
    assert.ok(r.preamble.some(p => p.includes('2026-01-01')));
    assert.ok(r.preamble.some(p => p.includes('2026-12-31')));
  });

  it('rejects between with wrong arg count', () => {
    assert.throws(() => compile({ between: [{ var: 'dueDate' }, { var: 'now' }] }), CompileError);
  });
});

describe('projectName variable', () => {
  it('compiles {var: "projectName"} for tasks', () => {
    const r = compile({ var: 'projectName' }, 'tasks');
    assert.match(r.condition, /containingProject/);
    assert.match(r.condition, /\.name/);
  });

  it('works in contains expression', () => {
    const r = compile({ contains: [{ var: 'projectName' }, 'litigation'] }, 'tasks');
    assert.match(r.condition, /containingProject/);
    assert.match(r.condition, /litigation/);
    assert.match(r.condition, /toLowerCase/);
  });
});

describe('complex expressions (compact syntax)', () => {
  it('compiles nested and/or', () => {
    const r = compile({
      and: [
        { or: [
          { eq: [{ var: 'flagged' }, true] },
          { contains: [{ var: 'tags' }, 'urgent'] }
        ]},
        { lte: [{ var: 'dueDate' }, { offset: { date: 'now', days: 7 } }] }
      ]
    });
    assert.match(r.condition, /&&/);
    assert.match(r.condition, /\|\|/);
  });

  it('compiles flagged + due within 7 days', () => {
    const r = compile({
      and: [
        { eq: [{ var: 'flagged' }, true] },
        { lte: [{ var: 'dueDate' }, { offset: { date: 'now', days: 7 } }] }
      ]
    });
    assert.match(r.condition, /_eq\(.*flagged.*,true\)/);
    assert.match(r.condition, /dueDate/);
  });

  it('compiles tasks modified in last 3 days', () => {
    const r = compile({
      gt: [{ var: 'modificationDate' }, { offset: { date: 'now', days: -3 } }]
    });
    assert.match(r.condition, /item\.modified/);
    assert.match(r.condition, />/);
  });

  it('compiles overdue tasks in folder', () => {
    const r = compile({
      and: [
        { container: ['folder', { contains: [{ var: 'name' }, 'PHS'] }] },
        { lt: [{ var: 'dueDate' }, { var: 'now' }] }
      ]
    });
    assert.match(r.condition, /parentFolder/);
    assert.match(r.condition, /_now/);
  });

  it('compiles NOT with tags', () => {
    const r = compile({
      not: [{ contains: [{ var: 'tags' }, 'someday'] }]
    });
    assert.match(r.condition, /!\(/);
    assert.match(r.condition, /indexOf\("someday"\)/);
  });
});

describe('old-style syntax rejection', () => {
  it('rejects {op, args} with helpful error', () => {
    try {
      compile({ op: 'contains', args: [{ var: 'name' }, 'test'] });
      assert.fail('Expected CompileError');
    } catch (e) {
      assert.ok(e instanceof CompileError);
      assert.match(e.message, /no longer supported/);
      assert.match(e.message, /compact syntax/);
      assert.match(e.message, /"contains"/);
    }
  });

  it('rejects old-style nested in new-style', () => {
    try {
      compile({ and: [{ op: 'eq', args: [{ var: 'flagged' }, true] }, true] });
      assert.fail('Expected CompileError');
    } catch (e) {
      assert.ok(e instanceof CompileError);
      assert.match(e.message, /no longer supported/);
    }
  });
});

describe('error messages', () => {
  it('unknown operation has available ops list', () => {
    try {
      compile({ bogusOp: [1, 10] });
      assert.fail('Expected CompileError');
    } catch (e) {
      assert.ok(e instanceof CompileError);
      assert.match(e.message, /Unrecognized node/);
    }
  });

  it('non-array args gives helpful error', () => {
    try {
      compile({ contains: 'not an array' });
      assert.fail('Expected CompileError');
    } catch (e) {
      assert.ok(e instanceof CompileError);
      assert.match(e.message, /must be an array/);
    }
  });

  it('includes useful info in error for nested expressions', () => {
    try {
      compile({ and: [{ eq: [{ var: 'bogus' }, 1] }, true] });
      assert.fail('Expected CompileError');
    } catch (e) {
      assert.ok(e instanceof CompileError);
      // Error message identifies the unknown variable
      assert.match(e.message, /Unknown variable "bogus"/);
    }
  });
});

describe('injection prevention', () => {
  it('escapes quotes in string literals', () => {
    const r = compile({ contains: [{ var: 'name' }, 'a"b'] });
    assert.match(r.condition, /a\\"b/);
  });

  it('escapes backslashes', () => {
    const r = compile({ contains: [{ var: 'name' }, 'a\\b'] });
    assert.match(r.condition, /a\\\\b/);
  });

  it('escapes in regex patterns', () => {
    const r = compile({ matches: [{ var: 'name' }, 'pattern"break'] });
    assert.ok(r.preamble.some(p => p.includes('pattern\\"break')));
  });
});

describe('preamble management', () => {
  it('accumulates multiple date constants', () => {
    const r = compile({
      and: [
        { lte: [{ var: 'dueDate' }, { offset: { date: 'now', days: 7 } }] },
        { gt: [{ var: 'modificationDate' }, { offset: { date: 'now', days: -3 } }] }
      ]
    });
    // Should have 2 offset preambles
    assert.ok(r.preamble.length >= 2);
  });

  it('uses unique var names', () => {
    const r = compile({
      and: [
        { offset: { date: 'now', days: -1 } },
        { offset: { date: 'now', days: -2 } },
        { offset: { date: 'now', days: 3 } }
      ]
    });
    // All preamble vars should be unique
    const varNames = r.preamble.map(p => p.match(/var (_\w+)/)?.[1]).filter(Boolean);
    assert.equal(new Set(varNames).size, varNames.length);
  });
});
