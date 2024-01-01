import SMB2 from 'v9u-smb2';
import sqlite3 from 'sqlite3';
import fs from 'fs';
import chokidar from 'chokidar';
import fetch from 'fetch'

// SMB file share configuration
const smbConfig = {
  share: '\\\\ip\\share-name',
  domain: '',
  username: '',
  password: '',
};

const smbClient = new SMB2(smbConfig); // Initialize the SMB client
const db = new sqlite3.Database('files.db'); // SQLite database
let pendingEvents = []
let fileCount = 1;

let pollingInProgress = false;

// Function to process file changes
function processFileChange(filePath, eventType) {
  const now = new Date()
  console.log(`${fileCount} - ${now.toLocaleDateString()} - ${now.toLocaleTimeString()} - ${eventType} - ${filePath}`);
  if (!pollingInProgress) pendingEvents.push(`${now.toLocaleDateString()} - ${now.toLocaleTimeString()} - ${eventType} - ${filePath}`);
  fileCount++;
}
function discordWebhook() {
  let params = {
    username: "Notify",
    avatar_url: "",
    embeds: [
      {
        "title": `Event Summary`,
        "description": `${pendingEvents.join("\n")}`,
        "color": 15258703,
        "timestamp": Date.now()
      }
    ]
  }
  pendingEvents = ""
  fetch('https://discord.com/api/webhooks/1190772673056342146/hW7MBES4jU1i8xMc5WmirGW9WyxOiI8-OexwhSNmWdVZK5LtV1LiG7_6Zf8yiPqn5fWD', {
    method: "POST",
    headers: {
      'Content-type': 'application/json'
    },
    body: JSON.stringify(params)
  }).then(res => {
    console.log(res);
  })
}

// Read existing file names from the database
let existingFiles = new Set();

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      lastModified INTEGER
    )
  `);

  db.each('SELECT path FROM files', (err, row) => {
    if (!err && row) {
      existingFiles.add(row.path);
    }
  });
});

// Function to index the entire SMB share
async function indexSMBShare() {
  return new Promise((resolve, reject) => {
    smbClient.readdir(smbConfig.share, (err, files) => {
      pollingInProgress = true;

      if (err) {
        reject(err);
        pollingInProgress = false;
        return;
      }

      if (Array.isArray(files)) {
        files.forEach(file => {
          const filePath = file.filename;
          existingFiles.add(filePath);
          // Update the database
          db.run('INSERT OR REPLACE INTO files (path, lastModified) VALUES (?, ?)', [filePath, Date.now()]);
        });
        resolve();
      } else {
        reject(new Error('Failed to retrieve file list from SMB share.'));
      }
    });
  });
}
console.log('\x1b[31m%s\x1b[0m',`Initial indexing starting.`,'\x1b[0m')
// Perform initial indexing
indexSMBShare()
  .then(() => {
    pollingInProgress = false;
    console.log('\x1b[31m%s\x1b[0m',`Initial indexing completed.`,'\x1b[0m');
    pendingEvents = []
    startPolling();
  })
  .catch(error => console.error(`Error during initial indexing: ${error.message}`));

// Watch for changes using chokidar
const watcher = chokidar.watch(smbConfig.share, {
  persistent: true,
  usePolling: true, // Use polling to detect changes
  interval: 1000,   // Polling interval in milliseconds
});

watcher
  .on('add', path => {
    if (!existingFiles.has(path)) {
      processFileChange(path, 'File added');
      existingFiles.add(path);
      // Update the database
      db.run('INSERT OR REPLACE INTO files (path, lastModified) VALUES (?, ?)', [path, Date.now()]);
    }
  })
  .on('change', path => processFileChange(path, 'File changed'))
  .on('unlink', path => {
    processFileChange(path, 'File deleted');
    existingFiles.delete(path);
    // Remove the file from the database
    db.run('DELETE FROM files WHERE path = ?', [path]);
  })
  .on('addDir', path => processFileChange(path, 'Directory added'))
  .on('unlinkDir', path => processFileChange(path, 'Directory deleted'))
  .on('error', error => console.error(`Error: ${error}`));

// Poll SMB share periodically for changes
function startPolling() {
  console.log('\x1b[31m%s\x1b[0m',`Polling beginning..`,'\x1b[0m')
  setInterval(() => {
    smbClient.readdir(smbConfig.share, (err, files) => {
      discordWebhook()
      if (err) {
        console.error('Error reading SMB share:', err);
        // Handle the specific error you want
        if (err.code === 'STATUS_LOGON_FAILURE') {
          console.error('Logon failure. Check username and password.');
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
    });
    console.log('\x1b[31m%s\x1b[0m',`Polling Completed`,'\x1b[0m')
  }, 1 * 60 * 6000); // Polling interval in milliseconds
}
