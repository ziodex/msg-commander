# Body tool fixtures

These synthetic fixtures exercise standard UTF-8, UTF-16 and UTF-32 encodings and GZip/raw Deflate. They contain the Unicode text in `sample.txt`, including exact integer source text. Tests compare decoded bytes and use independent Node.js compression readers/writers.

`gzip-headers.bin` exercises optional GZip header fields. The files are data fixtures, contain no executable plugin code and must retain their exact bytes across platform checkouts.
