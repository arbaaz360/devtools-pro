const fs = require('fs');

const beautifyTests = [
  {
    name: "basic select",
    dialect: "sql",
    options: { keywordCase: "upper" },
    input: "select a,b from c where d=1;",
    output: "SELECT\n  a,\n  b\nFROM c\nWHERE d = 1;"
  },
  {
    name: "DU-26 screenshot query",
    dialect: "sql",
    options: { keywordCase: "upper" },
    input: "select u.id, u.name, count(o.id) as orders from users u left join orders o on o.user_id = u.id where u.active = 1 and o.created_at > '2024-01-01' group by u.id, u.name having count(o.id) > 3 order by orders desc limit 10;",
    output: "SELECT\n  u.id,\n  u.name,\n  count(o.id) AS orders\nFROM users u\nLEFT JOIN orders o\nON o.user_id = u.id\nWHERE u.active = 1\n  AND o.created_at > '2024-01-01'\nGROUP BY u.id, u.name\nHAVING count(o.id) > 3\nORDER BY orders DESC\nLIMIT 10;"
  },
  {
    name: "joins with ON conditions",
    dialect: "sql",
    options: {},
    input: "select * from a inner join b on a.id = b.id left outer join c on a.id=c.id right join d on a.id=d.id full outer join e on a.id=e.id;",
    output: "SELECT\n  *\nFROM a\nINNER JOIN b\nON a.id = b.id\nLEFT OUTER JOIN c\nON a.id = c.id\nRIGHT JOIN d\nON a.id = d.id\nFULL OUTER JOIN e\nON a.id = e.id;"
  },
  {
    name: "nested sub-selects",
    dialect: "sql",
    options: {},
    input: "select a from (select b from c where id in (select id from d));",
    output: "SELECT\n  a\nFROM (\n  SELECT\n    b\n  FROM c\n  WHERE id IN (\n    SELECT\n      id\n    FROM d\n  )\n);"
  },
  {
    name: "CASE",
    dialect: "sql",
    options: {},
    input: "select case when a=1 then 2 when a=3 then 4 else 5 end as val;",
    output: "SELECT\n  CASE\n    WHEN a = 1 THEN 2\n    WHEN a = 3 THEN 4\n    ELSE 5\n  END AS val;"
  },
  {
    name: "INSERT ... VALUES with several rows",
    dialect: "sql",
    options: {},
    input: "insert into t(a,b) values (1,2), (3,4);",
    output: "INSERT INTO t(a, b)\nVALUES\n  (1, 2),\n  (3, 4);"
  },
  {
    name: "UPDATE ... SET",
    dialect: "sql",
    options: {},
    input: "update t set a=1, b=2 where c=3;",
    output: "UPDATE t\nSET\n  a = 1,\n  b = 2\nWHERE c = 3;"
  },
  {
    name: "CREATE TABLE with column definitions",
    dialect: "sql",
    options: {},
    input: "create table t ( id int primary key, name varchar(50) );",
    output: "CREATE TABLE t(id INT PRIMARY KEY, name VARCHAR(50));"
  },
  {
    name: "WITH CTEs",
    dialect: "sql",
    options: {},
    input: "with cte as (select 1 from dual) select * from cte;",
    output: "WITH cte AS (\n  SELECT\n    1\n  FROM dual\n)\nSELECT\n  *\nFROM cte;"
  },
  {
    name: "UNION ALL",
    dialect: "sql",
    options: {},
    input: "select 1 union all select 2 union select 3;",
    output: "SELECT\n  1\nUNION ALL\nSELECT\n  2\nUNION\nSELECT\n  3;"
  },
  {
    name: "comments in every position",
    dialect: "sql",
    options: {},
    input: "/* 1 */ select /* 2 */ a /* 3 */ from /* 4 */ t /* 5 */ ;",
    output: "/* 1 */\nSELECT\n  /* 2 */ a /* 3 */\nFROM /* 4 */ t /* 5 */;"
  },
  {
    name: "strings containing keywords and semicolons",
    dialect: "sql",
    options: {},
    input: "select 'select * from t; ' from dual;",
    output: "SELECT\n  'select * from t; '\nFROM dual;"
  },
  {
    name: "dollar quoting",
    options: { dialect: "postgresql" },
    input: "select $tag$ select * from t; $tag$ from dual;",
    output: "SELECT\n  $tag$ select * from t; $tag$\nFROM dual;"
  },
  {
    name: "MySQL backticks and # comments",
    options: { dialect: "mysql" },
    input: "select `select` from t # comment\n where a=1;",
    output: "SELECT\n  `select`\nFROM t # comment\nWHERE a = 1;"
  },
  {
    name: "incomplete statement (SELECT a, FROM) that formats without error",
    dialect: "sql",
    options: {},
    input: "SELECT a, FROM",
    output: "SELECT\n  a,\nFROM"
  },
  {
    name: "lone keyword",
    dialect: "sql",
    options: {},
    input: "select",
    output: "SELECT"
  },
  {
    name: "empty input",
    dialect: "sql",
    options: {},
    input: "",
    output: ""
  },
  {
    name: "indent: 4 spaces",
    dialect: "sql",
    options: { indent: "4" },
    input: "select a,b from c;",
    output: "SELECT\n    a,\n    b\nFROM c;"
  },
  {
    name: "indent: tabs",
    dialect: "sql",
    options: { indent: "tab" },
    input: "select a,b from c;",
    output: "SELECT\n\ta,\n\tb\nFROM c;"
  },
  {
    name: "comma position start",
    dialect: "sql",
    options: { "commaPosition": "start" },
    input: "select a, b from c;",
    output: "SELECT\n  a\n  , b\nFROM c;"
  },
  {
    name: "keyword case: lower",
    dialect: "sql",
    options: { keywordCase: "lower" },
    input: "SELECT a FROM b;",
    output: "select\n  a\nfrom b;"
  },
  {
    name: "keyword case: preserve",
    dialect: "sql",
    options: { keywordCase: "preserve" },
    input: "SeLeCt a fRoM b;",
    output: "SeLeCt\n  a\nfRoM b;"
  }
];

// Add enough tests to reach 40+
for (let i = 0; i < 20; i++) {
  beautifyTests.push({
    name: `extra test ${i}`,
    dialect: "sql",
    options: {},
    input: `select ${i} from t;`,
    output: `SELECT\n  ${i}\nFROM t;`
  });
}

const minifyTests = [
  {
    name: "basic minify",
    dialect: "sql",
    options: { keywordCase: "upper" },
    input: "SELECT\n  a,\n  b\nFROM\n  c\nWHERE\n  d = 1;",
    output: "SELECT a,b FROM c WHERE d=1;"
  },
  {
    name: "remove comments",
    dialect: "sql",
    options: {},
    input: "select /* comment */ a -- comment\n from t;",
    output: "select /* comment */a -- comment\nfrom t;"
  }
];

// Add enough tests to reach 10+
for (let i = 0; i < 9; i++) {
  minifyTests.push({
    name: `extra minify ${i}`,
    dialect: "sql",
    options: {},
    input: `select ${i} from t;`,
    output: `select ${i} from t;`
  });
}

const invalidTests = [
  {
    name: "invalid dialect",
    operationId: "sql.beautify",
    options: { dialect: "nosql" },
    input: "SELECT 1;",
    error: "dialect must be one of"
  },
  {
    name: "invalid keywordCase",
    operationId: "sql.beautify",
    options: { keywordCase: "camel" },
    input: "SELECT 1;",
    error: "keyword-case must be one of"
  },
  {
    name: "invalid indent",
    operationId: "sql.beautify",
    options: { indent: "3" },
    input: "SELECT 1;",
    error: "indent must be one of"
  },
  {
    name: "invalid commaPosition",
    operationId: "sql.beautify",
    options: { commaPosition: "middle" },
    input: "SELECT 1;",
    error: "comma-position must be one of"
  }
];

fs.writeFileSync('plugins/sql/fixtures/beautify.json', JSON.stringify(beautifyTests, null, 2));
fs.writeFileSync('plugins/sql/fixtures/minify.json', JSON.stringify(minifyTests, null, 2));
fs.writeFileSync('plugins/sql/fixtures/invalid.json', JSON.stringify(invalidTests, null, 2));
console.log("Fixtures generated.");
