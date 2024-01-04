import SMB2 from 'v9u-smb2';
import sqlite3 from 'sqlite3';
import fs from 'fs';
import chokidar from 'chokidar';
import fetch from 'node-fetch'

// $env:NODE_OPTIONS = "--openssl-legacy-provider"

// SMB file share configuration
const smbConfig = {
  share: '\\\\your-ip\\your-share',
  domain: '',
  username: '',
  password: '',
};

const webhookURL = ''

const smbClient = new SMB2(smbConfig); // Initialize the SMB client
const db = new sqlite3.Database('files.db'); // SQLite database
let pendingEvents = []
let fileCount = 1;

let indexInProgress = false; // Flag to indicate default indexing in progress
let pollingInProgress = false; // Flag to indicate regular polling in progress

// Function to process file changes
function processFileChange(filePath, eventType) {
  const now = new Date()
  console.log(`${fileCount} - ${now.toLocaleDateString()} - ${now.toLocaleTimeString()} - ${eventType} - ${filePath}`);
  if (!indexInProgress) pendingEvents.push(`${now.toLocaleTimeString()} - **${eventType}** - \`${filePath}\``);
  fileCount++;
}

function discordWebhook() {
  if (pendingEvents.length == 0) return
  if (pendingEvents.join("\n").length > 2000) {
    console.log("pendingEvents is greater than 2000")
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
      sendDiscordWebhook(chunk)
    }
    pendingEvents = []
  } else {
    sendDiscordWebhook(pendingEvents.join("\n"))
    pendingEvents = []
  }
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

// Function to index the entire SMB share
async function indexSMBShare() {
  return new Promise((resolve, reject) => {
    smbClient.readdir(smbConfig.share, { list: true }, (err, files) => {
      indexInProgress = true;
      if (err) {
        reject(err);
        indexInProgress = false;
        return;
      }

      if (Array.isArray(files)) {
        files.forEach(file => {
          const filePath = file.filename;
          if (file.isDirectory()) {
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
      } else {
        reject(new Error('Failed to retrieve file list from SMB share.'));
      }
    });
  });
}
console.log('\x1b[31m%s\x1b[0m', `Initial indexing starting.`, '\x1b[0m')

// Perform initial indexing
indexSMBShare()
  .then(() => {
    indexInProgress = false;
    console.log('\x1b[31m%s\x1b[0m', `Initial indexing completed.`, '\x1b[0m');
    pendingEvents = []
    startPolling();
  })
  .catch(error => {
    console.error(`Error during initial indexing: ${error.message}`)
    indexInProgress = false;
  });

// Watch for changes using chokidar
const watcher = chokidar.watch(smbConfig.share, {
  persistent: true,
  usePolling: true, // Use polling to detect changes
  interval: 1000,   // Polling interval in milliseconds
});

startPolling();
watcher
.on('add', path => {
  if (!existingFiles.has(path) && !existingDirectories.has(path)) {
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
  .on('addDir', path => processFileChange(path, 'Directory added'))
  .on('unlinkDir', path => processFileChange(path, 'Directory deleted'))
  .on('error', error => console.error(`Error: ${error}`));




function startPolling() {
  setInterval(() => {
    console.log('\x1b[31m%s\x1b[0m', `Polling beginning...`, '\x1b[0m')
    if (pollingInProgress) {
      console.log('\x1b[31m%s\x1b[0m', `Polling already in progress. Skipping this iteration.`, '\x1b[0m')
      return;
    }
    discordWebhook()

    pollingInProgress = true
    let start = process.hrtime()

    smbClient.readdir(smbConfig.share, (err, files) => {
      console.log("smbClient is polling")
      if (err) {
        pollingInProgress = false
        // Handle the specific error you want
        if (err.code === 'STATUS_LOGON_FAILURE') {
          console.error('Logon failure. Check username and password.');
        } else if (err.code === "STATUS_BAD_NETWORK_NAME" || err.code === "EISCONN" || err.code === "ETIMEDOUT") {
          console.error(`${err.code} ignored, skipping...`);
        } else {
          console.error('Error reading SMB share:', err);
        }
        return;
      }

      if (Array.isArray(files)) {
        files.forEach(file => {
          const filePath = file.filename;
          if (!existingFiles.has(filePath)) {
            processFileChange(filePath, 'File added');
            existingFiles.add(filePath);
            // Update the database
            db.run('INSERT OR REPLACE INTO files (path, lastModified) VALUES (?, ?)', [filePath, Date.now()]);
          }
        });
      }
      console.log('\x1b[31m%s\x1b[0m', `Polling Completed`, '\x1b[0m', `Time ${process.hrtime(start)[0]} s ${(process.hrtime(start)[1] / 1000000).toFixed(3)} ms`)

      // Call discordWebhook and reset the flag inside the readdir callback
      pollingInProgress = false;
    });

  }, 180 * 60 * 1000); // Polling interval in milliseconds
}
