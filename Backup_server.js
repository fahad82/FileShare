const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver'); // For zipping files

// Initialize Express app and server
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Middleware to parse JSON requests
app.use(express.json());

// Create the uploads directory if it doesn't exist
const uploadDir = './uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

// Serve static files from the 'uploads' directory
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Maximum total size for all files in a single request (10 GB)
const MAX_TOTAL_SIZE = 10 * 1024 * 1024 * 1024; // 10 GB in bytes

// Multer setup for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/'); // Save files in 'uploads' directory
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 * 1024 } // Limit file size to 10GB per file
}).array('files');  // Use multer's `array` for multiple file uploads

// Array to store uploaded file information
let uploadedFiles = [];

// Function to read existing files from the uploads directory
function loadExistingFiles() {
  fs.readdir(uploadDir, (err, files) => {
    if (err) {
      console.error('Error reading uploads directory:', err);
      return;
    }

    // Populate uploadedFiles with existing files
    uploadedFiles = files.map(file => {
      return {
        fileName: file,
        fileUrl: `/uploads/${file}`,
        filePath: path.join(uploadDir, file),
        fileId: file
      };
    });
    
    // Emit initial files to connected clients
    io.emit('initialFiles', uploadedFiles);
  });
}

// Load existing files when the server starts
loadExistingFiles();

// Endpoint to upload files
app.post('/upload', (req, res) => {
  upload(req, res, function (err) {
    if (err instanceof multer.MulterError) {
      console.error('Multer error:', err);
      return res.status(500).send(`Multer error: ${err.message}`);
    } else if (err) {
      console.error('Unknown error during file upload:', err);
      return res.status(500).send('Server error during file upload.');
    }

    const files = req.files; // Capture uploaded files
    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).send('No files uploaded.');
    }

    // Calculate total size of the uploaded files
    const totalSize = files.reduce((acc, file) => acc + file.size, 0);
    if (totalSize > MAX_TOTAL_SIZE) {
      console.error('Total file size exceeds 10GB limit');
      return res.status(400).send(`Total file size exceeds the 10GB limit.`);
    }

    const fileInfos = files.map(file => {
      const fileInfo = {
        fileName: file.originalname,
        fileUrl: `/uploads/${file.filename}`,
        filePath: path.join(__dirname, 'uploads', file.filename),
        fileId: file.filename
      };

      // Set a timeout to delete the file after 2 hours
      setTimeout(() => {
        fs.unlink(fileInfo.filePath, (err) => {
          if (err) {
            console.error(`Failed to delete ${fileInfo.fileName}:`, err);
          } else {
            console.log(`${fileInfo.fileName} has been deleted after 2 hours.`);
            uploadedFiles = uploadedFiles.filter(f => f.fileId !== fileInfo.fileId);
            io.emit('fileDeleted', fileInfo.fileId);
          }
        });
      }, 2 * 60 * 60 * 1000); // 2 hours in milliseconds

      uploadedFiles.push(fileInfo);
      return fileInfo;
    });

    io.emit('filesUploaded', fileInfos);
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
        console.log(`${file.fileName} has been deleted.`);
      }
    });
  });

  uploadedFiles = []; // Clear the uploadedFiles array
  io.emit('fileDeleted', 'all'); // Notify all clients that all files have been deleted
  res.send('All files deletion initiated.');
});

// Endpoint to download all files as a zip
app.get('/download-all', (req, res) => {
  const zipFileName = 'all_files.zip';
  res.attachment(zipFileName); // Set the file name for the zip file

  const archive = archiver('zip');
  archive.pipe(res); // Pipe the archive data to the response

  uploadedFiles.forEach(file => {
    archive.file(file.filePath, { name: file.fileName });
  });

  archive.finalize();
});

// Endpoint to delete files
app.post('/delete-files', (req, res) => {
  const { fileIds } = req.body; // Get file IDs to delete

  // Validate file IDs
  if (!fileIds || !Array.isArray(fileIds)) {
    return res.status(400).send('Invalid file IDs');
  }

  fileIds.forEach(fileId => {
    const fileToDelete = uploadedFiles.find(file => file.fileId === fileId);
    
    if (fileToDelete) {
      // Delete the file from the filesystem
      fs.unlink(fileToDelete.filePath, (err) => {
        if (err) {
          console.error(`Failed to delete ${fileToDelete.fileName}:`, err);
        } else {
          console.log(`${fileToDelete.fileName} has been deleted.`);
          
          // Remove the file from the uploadedFiles array
          uploadedFiles = uploadedFiles.filter(file => file.fileId !== fileId);

          // Notify all connected clients that the file has been deleted
          io.emit('fileDeleted', fileId);
        }
      });
    }
  });

  res.send('Files deletion initiated.');
});

// Serve the HTML file for the frontend
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
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
