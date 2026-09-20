import { readFile, writeFile } from 'node:fs/promises';
import { execute, normalizeOptions } from '../plugins/sql/processor.mjs';
import { MemoryReader, MemoryOutputSink, CancellationToken, FixedClock, SeededRandom, MemorySecrets, ProcessorContext } from '../packages/plugin-sdk/src/index.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function runBeautify(input, options = {}) {
  const reader = new MemoryReader().insert('input', encoder.encode(input));
  const outputs = new MemoryOutputSink();
  const limits = { maxInputBytes: 1048576, maxOutputBytes: 1048576, maxChunkBytes: 1048576, deadlineMs: 1000 };
  const context = new ProcessorContext(reader, outputs, new CancellationToken(), new FixedClock('2025-01-01T00:00:00Z'), new SeededRandom(1), new MemorySecrets(), limits);
  await execute({ operationId: 'beautify', options }, context);
  return decoder.decode(outputs.bytes.get('output'));
}

async function main() {
  const json = JSON.parse(await readFile('./plugins/sql/fixtures/beautify.json', 'utf8'));
  
  const add = async (name, input, options = {}) => {
    const output = await runBeautify(input, options);
    json.push({ name, dialect: options.dialect || 'sql', options, input, output });
  };

  await add('plsql dialect block', 'declare v_num int := 1; begin dbms_output.put_line(v_num); end;', { dialect: 'plsql' });
  await add('plsql block uppercase', 'declare v_num int := 1; begin dbms_output.put_line(v_num); end;', { dialect: 'plsql', 'keyword-case': 'upper' });
  await add('postgresql distinct', 'select distinct on (a) a, b from c;', { dialect: 'postgresql' });
  await add('comma-position start', 'select a, b, c from t group by a, b;', { 'comma-position': 'start' });
  await add('comma-position start nested', 'select a, (select b, c from d), e from t;', { 'comma-position': 'start' });
  await add('comma-position start with function', 'select coalesce(a, b, c), d from t;', { 'comma-position': 'start' });
  await add('keyword case lower', 'SELECT A, B FROM C WHERE D = 1;', { 'keyword-case': 'lower' });
  await add('keyword case preserve', 'seLEct A, B frOM C wHEre D = 1;', { 'keyword-case': 'preserve' });
  await add('indent space-4', 'select a from b where c = 1;', { indent: 'space-4' });
  await add('indent tab', 'select a from b where c = 1;', { indent: 'tab' });
  await add('multi-statement with mixed comments', '-- standard comment\nselect 1;\n# mysql comment\nselect 2;\n/* multi\nline */\nselect 3;', { dialect: 'mysql' });
  await add('multi-statement mariadb comments', '# mariadb comment\nselect 1;', { dialect: 'mariadb' });
  await add('postgresql nested lists', "select array[1, 2, 3], json_build_object('a', 1, 'b', 2);", { dialect: 'postgresql', 'comma-position': 'start' });
  await add('mysql backticks', 'select `table`.`column` from `table`;', { dialect: 'mysql' });
  await add('complex joins with comma start', 'select a.id, b.name, c.value from a join b on a.id = b.id left join c on b.id = c.id;', { 'comma-position': 'start' });
  await add('plsql string escaping', "select 'hello ''world''' from dual;", { dialect: 'plsql' });
  await add('plsql function call', 'select my_func(a, b, c) from dual;', { dialect: 'plsql' });
  await add('update statement', 'update t set a = 1, b = 2 where c = 3;', { 'comma-position': 'start' });
  await add('insert statement', 'insert into t (a, b, c) values (1, 2, 3), (4, 5, 6);', { 'comma-position': 'start' });

  await writeFile('./plugins/sql/fixtures/beautify.json', JSON.stringify(json, null, 2));
}

main().catch(console.error);
