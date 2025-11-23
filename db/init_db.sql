-- 🚨 請注意：這會刪掉 live_platform 的所有資料！
DROP DATABASE IF EXISTS live_platform;

-- 🧱 重新建立資料庫
CREATE DATABASE IF NOT EXISTS live_platform CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE live_platform;

-- 👤 使用者表
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  email VARCHAR(100) NOT NULL,
  password VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  gender ENUM('男','女','非二元','不透露') DEFAULT '不透露',
  age INT DEFAULT NULL,
  avatar VARCHAR(255) DEFAULT '/uploads/default_avatar.png',
  balance DECIMAL(10,2) DEFAULT 0.00
);

-- 📡 直播表
CREATE TABLE IF NOT EXISTS streams (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  room_id VARCHAR(100) NOT NULL UNIQUE,
  title VARCHAR(100) NOT NULL,
  cover VARCHAR(255),
  description TEXT,
  hashtags VARCHAR(255),
  status BOOLEAN DEFAULT TRUE,
  last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 🏷️ Hashtag 表
CREATE TABLE IF NOT EXISTS hashtags (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tag_name VARCHAR(50) NOT NULL UNIQUE,
  usage_count INT DEFAULT 1,
  vector_x FLOAT DEFAULT 0,
  vector_y FLOAT DEFAULT 0,
  vector_z FLOAT DEFAULT 0
);
