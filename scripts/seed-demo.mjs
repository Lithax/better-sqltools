// Creates examples/demo/demo.db: deterministic sample data for trying the extension (npm run seed:demo).
import initSqlJs from 'sql.js';
import { mkdirSync, writeFileSync } from 'node:fs';

const SQL = await initSqlJs();
const db = new SQL.Database();

db.run(`
  CREATE TABLE authors (
    id      INTEGER PRIMARY KEY,
    name    TEXT NOT NULL,
    country TEXT,
    born    INTEGER
  );
  CREATE TABLE books (
    id        INTEGER PRIMARY KEY,
    author_id INTEGER NOT NULL REFERENCES authors(id),
    title     TEXT NOT NULL,
    year      INTEGER,
    pages     INTEGER,
    rating    REAL,
    in_print  BOOLEAN DEFAULT 1,
    note      TEXT
  );
  CREATE INDEX idx_books_author ON books (author_id);
  CREATE INDEX idx_books_year ON books (year);
  CREATE VIEW book_stats AS
    SELECT a.name AS author, count(*) AS books, round(avg(b.rating), 2) AS avg_rating, sum(b.pages) AS total_pages
      FROM authors a JOIN books b ON b.author_id = a.id
     GROUP BY a.id;
  CREATE TABLE audit_log (id INTEGER PRIMARY KEY, at TEXT DEFAULT CURRENT_TIMESTAMP, what TEXT);
  CREATE TRIGGER trg_books_insert AFTER INSERT ON books
  BEGIN
    INSERT INTO audit_log (what) VALUES ('book added: ' || NEW.title);
  END;
`);

const authors = [
  ['Ursula K. Le Guin', 'US', 1929], ['Stanisław Lem', 'PL', 1921], ['Octavia E. Butler', 'US', 1947],
  ['Italo Calvino', 'IT', 1923], ['Chinua Achebe', 'NG', 1930], ['Clarice Lispector', 'BR', 1920],
  ['Haruki Murakami', 'JP', 1949], ['Margaret Atwood', 'CA', 1939], ['Jorge Luis Borges', 'AR', 1899],
  ['Toni Morrison', 'US', 1931], ['Terry Pratchett', 'GB', 1948], ['Tove Jansson', 'FI', 1914],
];
authors.forEach((a, i) => db.run('INSERT INTO authors VALUES (?, ?, ?, ?)', [i + 1, ...a]));

const nouns = ['Garden', 'Machine', 'Archive', 'River', 'Mirror', 'Orchard', 'Lighthouse', 'Atlas', 'Harbor', 'Engine', 'Cartographer', 'Winter'];
const adjs = ['Quiet', 'Borrowed', 'Last', 'Hidden', 'Paper', 'Distant', 'Second', 'Salt', 'Glass', 'Northern'];
for (let i = 1; i <= 300; i++) {
  const title = `The ${adjs[i % adjs.length]} ${nouns[(i * 7) % nouns.length]}${i > 120 ? ` ${Math.ceil(i / 120)}` : ''}`;
  db.run('INSERT INTO books (id, author_id, title, year, pages, rating, in_print, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
    i, 1 + ((i * 5) % authors.length), title, 1950 + ((i * 13) % 74), 120 + ((i * 37) % 600),
    Math.round((2.5 + ((i * 17) % 25) / 10) * 10) / 10, i % 9 === 0 ? 0 : 1, i % 11 === 0 ? null : i % 7 === 0 ? 'Out of stock.\nReprint planned.' : 'ok',
  ]);
}
db.run('DELETE FROM audit_log'); // seeding is not an audit event

mkdirSync('examples/demo', { recursive: true });
writeFileSync('examples/demo/demo.db', db.export());
console.log('wrote examples/demo/demo.db');
