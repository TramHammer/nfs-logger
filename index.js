import fs from 'fs';
import sqlite3 from 'sqlite3';
import chokidar from 'chokidar';
import fetch from 'node-fetch';

const nfsConfig = {
  share: '\\\\share-ip\\share', // Replace with your NFS server and path
};

const webhookURL = '';

const db = new sqlite3.Database('files.db'); // SQLite database
let pendingEvents = [];
let fileCount = 1;

let indexInProgress = false; // Flag to indicate default indexing in progress
let pollingInProgress = false; // Flag to indicate regular polling in progress

// Function to process file changes
function processFileChange(filePath, eventType) {
  const now = new Date();
  console.log(`${fileCount} - ${now.toLocaleDateString()} - ${now.toLocaleTimeString()} - ${eventType} - ${filePath}`);
  if (!indexInProgress) pendingEvents.push(`${now.toLocaleTimeString()} - **${eventType}** - \`${filePath}\``);
  fileCount++;
}

function discordWebhook() {
  if (pendingEvents.length == 0) return;
  if (pendingEvents.join('\n').length > 2000) {
    console.log('pendingEvents is greater than 2000');
    const chunkSize = 2000; // Maximum length for a Discord message
    const chunks = [];

    let currentChunk = '';
    for (const event of pendingEvents) {
      const eventLength = event.length;

      if (currentChunk.length + eventLength > chunkSize) {
        // If adding the current event exceeds the chunk size, start a new chunk
        chunks.push(currentChunk);
        currentChunk = event;
      } else {
        // Otherwise, add the event to the current chunk
        currentChunk += '\n' + event;
      }
    }

    // Add the last chunk, if any
    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }

    for (const chunk of chunks) {
      sendDiscordWebhook(chunk);
    }
    pendingEvents = [];
  } else {
    sendDiscordWebhook(pendingEvents.join('\n'));
    pendingEvents = [];
  }
}

async function sendDiscordWebhook(message) {
  const now = new Date();
  let params = {
    content: '',
    tts: false,
    username: '10.0.1.23 Notification System',
    embeds: [
      {
        title: `Event Summary`,
        description: `${message}`,
        fields: [],
        color: 13395968,
        timestamp: now.toISOString(),
        footer: {
          text: 'NFS Server'
        }
      }
    ]
  };
  await fetch(webhookURL, {
    method: 'POST',
    headers: {
      'Content-type': 'application/json'
    },
    body: JSON.stringify(params)
  })
    .then(res => {
      console.log(`${now.toLocaleDateString()} - ${now.toLocaleTimeString()} - Successfully sent webhook message.`);
    })
    .catch(res => {
      console.error(res);
    });
}

let existingFiles = new Set();
let existingDirectories = new Set();

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      lastModified INTEGER,
      type TEXT
    )
  `);

  db.each('SELECT path, type FROM files', (err, row) => {
    if (!err && row) {
      if (row.type === 'file') {
        existingFiles.add(row.path);
      } else if (row.type === 'directory') {
        existingDirectories.add(row.path);
      }
    }
  });
});

// Function to index the entire NFS share
async function indexNFSShare() {
  return new Promise((resolve, reject) => {
    // Implement your NFS client logic here to retrieve file list
    // Update existingDirectories and existingFiles accordingly
    // For example, you can use 'fs.readdir' with NFS-mounted path
    // Mock implementation:
    const files = fs.readdirSync(nfsConfig.share);
    files.forEach(file => {
      const filePath = `${nfsConfig.share}/${file}`;
      if (fs.statSync(filePath).isDirectory()) {
        existingDirectories.add(filePath);
        // Update the database
        db.run('INSERT OR REPLACE INTO files (path, lastModified, type) VALUES (?, ?, ?)', [filePath, Date.now(), 'directory']);
      } else {
        existingFiles.add(filePath);
        // Update the database
        db.run('INSERT OR REPLACE INTO files (path, lastModified, type) VALUES (?, ?, ?)', [filePath, Date.now(), 'file']);
      }
    });
    resolve();
  });
}

console.log('\x1b[31m%s\x1b[0m', `Initial indexing starting.`, '\x1b[0m');

// Perform initial indexing
indexNFSShare()
  .then(() => {
    indexInProgress = false;
    console.log('\x1b[31m%s\x1b[0m', `Initial indexing completed.`, '\x1b[0m');
    pendingEvents = [];
    startPolling();
  })
  .catch(error => {
    console.error(`Error during initial indexing: ${error.message}`);
    indexInProgress = false;
  });

// Watch for changes using chokidar
const watcher = chokidar.watch(nfsConfig.share, {
  persistent: true,
  usePolling: true, // Use polling to detect changes
  interval: 1000,   // Polling interval in milliseconds
});

startPolling();

watcher
  .on('add', path => {
    if (!existingFiles.has(path)) {
      const isDirectory = fs.statSync(path).isDirectory();
      processFileChange(path, isDirectory ? 'Directory added' : 'File added');
      if (isDirectory) {
        existingDirectories.add(path);
        // Update the database
        db.run('INSERT OR REPLACE INTO files (path, lastModified, type) VALUES (?, ?, ?)', [path, Date.now(), 'directory']);
      } else {
        existingFiles.add(path);
        // Update the database
        db.run('INSERT OR REPLACE INTO files (path, lastModified, type) VALUES (?, ?, ?)', [path, Date.now(), 'file']);
      }
    }
  })
  .on('change', path => processFileChange(path, 'File changed'))
  .on('unlink', path => {
    const isDirectory = existingDirectories.has(path);
    processFileChange(path, isDirectory ? 'Directory deleted' : 'File deleted');
    if (isDirectory) {
      existingDirectories.delete(path);
      // Remove the directory from the database
      db.run('DELETE FROM files WHERE path = ?', [path]);
    } else {
      existingFiles.delete(path);
      // Remove the file from the database
      db.run('DELETE FROM files WHERE path = ?', [path]);
    }
  })
  .on('addDir', path => {
    if (!existingDirectories.has(path)) {
      processFileChange(path, 'Directory added');
      existingDirectories.add(path);
      // Update the database
      db.run('INSERT OR REPLACE INTO files (path, lastModified, type) VALUES (?, ?, ?)', [path, Date.now(), 'directory']);
    }
  })
  .on('unlinkDir', path => {
    const isDirectory = existingDirectories.has(path);
    processFileChange(path, isDirectory ? 'Directory deleted' : 'File deleted');
    if (isDirectory) {
      existingDirectories.delete(path);
      // Remove the directory from the database
      db.run('DELETE FROM files WHERE path = ?', [path]);
    }
  })
  .on('error', error => console.error(`Error: ${error}`));


setInterval(() => {
  discordWebhook()
}, 15 * 60 * 1000)


function startPolling() {
  setInterval(() => {
    console.log('\x1b[31m%s\x1b[0m', `Polling beginning...`, '\x1b[0m');
    if (pollingInProgress) {
      console.log('\x1b[31m%s\x1b[0m', `Polling already in progress. Skipping this iteration.`, '\x1b[0m');
      return;
    }

    pollingInProgress = true;
    let start = process.hrtime();

    // Implement your NFS client logic here to retrieve file list
    // Update existingDirectories and existingFiles accordingly
    // Mock implementation:
    const files = fs.readdirSync(nfsConfig.share);
    files.forEach(file => {
      const filePath = `${nfsConfig.share}/${file}`;
      if (!existingFiles.has(filePath)) {
        processFileChange(filePath, 'File added');
        existingFiles.add(filePath);
        // Update the database
        db.run('INSERT OR REPLACE INTO files (path, lastModified) VALUES (?, ?)', [filePath, Date.now()]);
      }
    });

    console.log('\x1b[31m%s\x1b[0m', `Polling Completed`, '\x1b[0m', `Time ${process.hrtime(start)[0]} s ${(process.hrtime(start)[1] / 1000000).toFixed(3)} ms`);

    // Call discordWebhook and reset the flag inside the readdir callback
    //discordWebhook();
    pollingInProgress = false;
  }, 180 * 60 * 1000); // Polling interval in milliseconds
}
