-- Ctrl+Enter (Cmd+Enter on a Mac) runs the statement under the cursor.
-- Ctrl+Shift+Enter runs the whole file. Results appear in the SQL Results panel.

SELECT * FROM books ORDER BY rating DESC LIMIT 20;

-- Completion knows the schema: try typing "SELECT b." below, or "FROM bo".
SELECT a.name, b.title, b.year
FROM books b
JOIN authors a ON a.id = b.author_id
WHERE b.year < 1960
ORDER BY b.year;

SELECT * FROM book_stats ORDER BY avg_rating DESC;

-- Several statements in one run give you one tab per statement.
SELECT count(*) AS books FROM books;
SELECT country, count(*) AS authors FROM authors GROUP BY country ORDER BY authors DESC;

-- This one writes. The triggers fire and the file is saved.
INSERT INTO books (author_id, title, year, pages, rating) VALUES (1, 'The Dispossessed (annotated)', 1974, 387, 4.7);
SELECT * FROM audit_log;

-- sqlfluff (if installed) flags this one's layout; the quick fix and Format Document repair it.
select a.name,count(*) as n from authors a join books b on b.author_id=a.id group by a.name
