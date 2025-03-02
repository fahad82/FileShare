const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.json());
app.use(express.static('public'));

const uploadDir = './uploads';
const uploadsJsonPath = path.join(__dirname, 'uploads.json');

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

// Serve static files from the 'uploads' directory
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const MAX_TOTAL_SIZE = 10 * 1024 * 1024 * 1024; // 10GB limit

// Multer setup for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 * 1024 } 
}).array('files');

// Stores uploaded file metadata
let uploadedFiles = [];

// Function to read existing file metadata
function loadFileMetadata() {
  if (!fs.existsSync(uploadsJsonPath)) return [];
  try {
    const data = fs.readFileSync(uploadsJsonPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading uploads.json:', error);
    return [];
  }
}

// Function to save file metadata
function saveFileMetadata() {
  fs.writeFileSync(uploadsJsonPath, JSON.stringify(uploadedFiles, null, 2));
}

function scheduleFileDeletion(file) {
  // const deletionTime = 2 * 60 * 60 * 1000; // 2 hours
  const deletionTime = 60  * 1000;
  const timeElapsed = Date.now() - file.uploadTime;
  let remainingTime = deletionTime - timeElapsed;

  if (remainingTime <= 0) {
    fs.unlink(file.filePath, (err) => {
      if (!err) {
        uploadedFiles = uploadedFiles.filter(f => f.fileId !== file.fileId);
        saveFileMetadata();
        io.emit('fileDeleted', file.fileId);
      }
    });
  } else {
    io.emit('fileTimerUpdate', { fileId: file.fileId, remainingTime });

    // Send updates every second
    const interval = setInterval(() => {
      remainingTime -= 1000;
      if (remainingTime <= 0) {
        clearInterval(interval);
        fs.unlink(file.filePath, (err) => {
          if (!err) {
            uploadedFiles = uploadedFiles.filter(f => f.fileId !== file.fileId);
            saveFileMetadata();
            io.emit('fileDeleted', file.fileId);
          }
        });
      } else {
        io.emit('fileTimerUpdate', { fileId: file.fileId, remainingTime });
      }
    }, 1000);
  }
}


// Function to load existing files and apply deletion timers only if needed
function loadExistingFiles() {
  uploadedFiles = loadFileMetadata();
  uploadedFiles.forEach(file => scheduleFileDeletion(file));
  io.emit('initialFiles', uploadedFiles);
}

// Load existing files on startup
loadExistingFiles();

// Endpoint to upload files
app.post('/upload', (req, res) => {
  upload(req, res, function (err) {
    if (err) {
      console.error('Upload error:', err);
      return res.status(500).send('Upload failed.');
    }

    const files = req.files;
    if (!files || files.length === 0) return res.status(400).send('No files uploaded.');

    const newFiles = files.map(file => {
      return {
        fileName: file.originalname,
        fileUrl: `/uploads/${file.filename}`,
        filePath: path.join(__dirname, 'uploads', file.filename),
        fileId: file.filename,
        uploadTime: Date.now()
      };
    });

    // ✅ Append new files instead of overwriting uploadedFiles
    uploadedFiles = [...uploadedFiles, ...newFiles];
    saveFileMetadata();

    // ✅ Schedule deletion for each new file
    newFiles.forEach(file => scheduleFileDeletion(file));

    io.emit('filesUploaded', newFiles);
    res.send('Files uploaded successfully.');
  });
});

// Endpoint to delete all files
app.post('/delete-all-files', (req, res) => {
  uploadedFiles.forEach(file => {
    fs.unlink(file.filePath, (err) => {
      if (err) {
        console.error(`Failed to delete ${file.fileName}:`, err);
      } else {
        console.log(`${file.fileName} deleted.`);
      }
    });
  });

  uploadedFiles = [];
  saveFileMetadata();
  io.emit('fileDeleted', 'all');
  res.send('All files deleted.');
});

// Endpoint to download all files as a zip
app.get('/download-all', (req, res) => {
  const zipFileName = 'all_files.zip';
  res.attachment(zipFileName);

  const archive = archiver('zip');
  archive.pipe(res);

  uploadedFiles.forEach(file => {
    archive.file(file.filePath, { name: file.fileName });
  });

  archive.finalize();
});

// Endpoint to delete specific files
app.post('/delete-files', (req, res) => {
  const { fileIds } = req.body;

  if (!fileIds || !Array.isArray(fileIds)) {
    return res.status(400).send('Invalid file IDs');
  }

  fileIds.forEach(fileId => {
    const fileToDelete = uploadedFiles.find(file => file.fileId === fileId);

    if (fileToDelete) {
      fs.unlink(fileToDelete.filePath, (err) => {
        if (!err) {
          console.log(`${fileToDelete.fileName} deleted.`);
          uploadedFiles = uploadedFiles.filter(f => f.fileId !== fileId);
          saveFileMetadata();
          io.emit('fileDeleted', fileId);
        }
      });
    }
  });

  res.send('Files deletion initiated.');
});

// Serve the frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Socket.io connection handler
io.on('connection', (socket) => {
  console.log('A user connected');
  socket.emit('initialFiles', uploadedFiles);

  socket.on('disconnect', () => {
    console.log('A user disconnected');
  });
});

// Start the server
const PORT = process.env.PORT || 3002;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
