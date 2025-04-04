const fs = require('fs');
const puppeteer = require('puppeteer');
const cliProgress = require('cli-progress');
const UserAgent1 = require('user-agents');  // 引入生成随机用户代理模块

const MAX_RETRIES = 2; // 最大重试次数

// 生成随机延迟（500 到 2000 毫秒之间）
function getRandomDelay() {
  return Math.floor(Math.random() * 1500) + 500;
}

// 生成随机视口大小
function getRandomViewport() {
  const width = Math.floor(Math.random() * (1920 - 1024)) + 1024;
  const height = Math.floor(Math.random() * (1080 - 768)) + 768;
  return { width, height };
}

async function loginAndDownload(account) {
  const userAgent2 = new UserAgent1(); // 创建 UserAgent 实例
  const randomUserAgent = userAgent2.toString(); // 获取随机用户代理

  // 从环境变量读取 Chromium 或 Chrome 的可执行文件路径
  const executablePath = process.env.CHROME_PATH || null; // 如果没有设置环境变量，则为 null

  const browser = await puppeteer.launch({
    headless: 'new', // 使用新的无头模式
    executablePath, // 使用环境变量中的路径，如果没有设置则使用 Puppeteer 内置的 Chromium
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-zygote',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      // `--proxy-server=http://127.0.0.1:20171` // 注释掉代理地址
    ],
    defaultViewport: getRandomViewport(), // 使用随机视口大小
    ignoreHTTPSErrors: true, // 忽略HTTPS错误
    waitForInitialPage: true, // 等待初始页面加载
  });

  const page = await browser.newPage();
  await page.setUserAgent(randomUserAgent); // 设置随机的 User-Agent

  // 确保 progressBar 在整个函数范围内定义
  let progressBar;

  try {
    // 显示进度条
    progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    progressBar.start(100, 0); // 开始进度条

    let retryCount = 0;
    let loginSuccess = false;

    while (retryCount < MAX_RETRIES && !loginSuccess) {
      try {
        
        await page.setDefaultTimeout(30000); // 设置默认超时时间为30秒
        await page.setDefaultNavigationTimeout(30000); // 设置导航超时时间为30秒

        await page.goto('https://deno-arna-ephone-proxy.deno.dev/login', {
          waitUntil: 'networkidle0',
          timeout: 30000
        });
        progressBar.update(20);

        // 等待页面加载完成
        await new Promise(resolve => setTimeout(resolve, 3000));

        // 等待对话框按钮出现
        await page.waitForSelector('#dialog-0 > div > div.semi-modal-footer > button.semi-button.semi-button-primary > span', {
          timeout: 30000,
          visible: true
        });
        const buttons1 = await page.$$('#dialog-0 > div > div.semi-modal-footer > button.semi-button.semi-button-primary > span');
        for (let button of buttons1) {
          const text = await page.evaluate(el => el.innerText, button);
          if (text === '确定') {
            const buttonBox = await button.boundingBox(); // 获取按钮的位置
            if (buttonBox) {
              await page.mouse.move(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2); // 模拟鼠标移动到按钮上
              await new Promise(resolve => setTimeout(resolve, getRandomDelay())); // 模拟点击停顿
              await page.mouse.click(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2); // 点击按钮
            }
          }
        }
        await new Promise(resolve => setTimeout(resolve, getRandomDelay()));
        
        // 输入用户名和密码，并添加随机延迟
        await page.waitForSelector('#username');
        await page.type('#username', account.username);
        await new Promise(resolve => setTimeout(resolve, getRandomDelay()));

        await page.waitForSelector('#password');
        await page.type('#password', account.password);
        await new Promise(resolve => setTimeout(resolve, getRandomDelay()));
        progressBar.update(50);

        // 查找并点击登录按钮，模拟鼠标移动和点击
        await page.waitForSelector('button > span');
        const buttons = await page.$$('button > span');
        for (let button of buttons) {
          const text = await page.evaluate(el => el.innerText, button);
          if (text === '登录') {
            const buttonBox = await button.boundingBox(); // 获取按钮的位置
            if (buttonBox) {
              await page.mouse.move(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2); // 模拟鼠标移动到按钮上
              await new Promise(resolve => setTimeout(resolve, getRandomDelay())); // 模拟点击停顿
              await page.mouse.click(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2); // 点击按钮
            }
            break;
          }
        }

        // 等待 8 秒来检测是否跳转到目标页面
        await new Promise(resolve => setTimeout(resolve, 8000));

        // 检查是否跳转到 "/panel" 页面
        const currentUrl = page.url();
        if (currentUrl.includes('/panel')) {
          console.log(`账户 ${account.username} 登录成功！`);
          progressBar.update(70);
          loginSuccess = true;

          // 添加签到功能逻辑，等待签到页面加载
          await page.waitForSelector('#semiTabcheckin > span');
          await page.click('#semiTabcheckin > span');
          progressBar.update(80);

          // 查找签到按钮，判断是否存在 "去签到" 按钮
          const signInButton = await page.$('#semiTabPanelcheckin > div > div > div.semi-calendar-month-grid-wrapper > div > ul div[role="button"]');

          if (!signInButton) {
            // 没有找到签到按钮
            console.log(`账户 ${account.username} 已经签到，跳过签到流程`);
          } else {
            // 找到“去签到”按钮
            console.log(`账户 ${account.username} 尚未签到，准备进行签到...`);

            let signInSuccess = false;
            const spanText = await page.evaluate(el => el.innerText, signInButton);
            if (spanText.includes('去签到')) {  // 找到“去签到”按钮
              await signInButton.click();  // 点击“去签到”按钮
              console.log(`账户 ${account.username} 正在签到...`);

              // 等待元素的 class 和文本内容从 "去签到" 更新为 "已签到"
              await page.waitForFunction(
                el => el.innerText.includes('已签到') && el.classList.contains('semi-tag-green-light'),
                { timeout: 10000 }, 
                signInButton
              );

              console.log(`账户 ${account.username} 签到成功！`);
              signInSuccess = true;
            }

            if (!signInSuccess) {
              console.log(`账户 ${account.username} 签到失败，未找到“去签到”按钮`);
            }
          }

        } else {
          console.log(`账户 ${account.username} 登录失败，未跳转到预期页面`);
        }

      } catch (error) {
        console.log(`账户 ${account.username} 登录错误: ${error.message}`);
        retryCount++;
        if (retryCount < MAX_RETRIES) {
          // 等待 60 秒再重新尝试登录
          await new Promise(resolve => setTimeout(resolve, 60000));
          console.log(`重试登录（${retryCount}/${MAX_RETRIES}）...`);
        }
      }
    }

    if (!loginSuccess) {
      console.log(`账户 ${account.username} 登录失败，已达到最大重试次数`);
      return false;
    }
  } catch (error) {
    console.log(`账户 ${account.username} 登录错误: ${error.message}`);
    return false;
  } finally {
    if (progressBar) {  // 确保进度条存在再调用 stop()
      progressBar.stop();
    }
    await browser.close();
  }
}

// 调用此函数以对多个帐号进行签到
async function signInMultipleAccounts(accounts) {
  for (let account of accounts) {
    console.log(`正在处理账户 ${account.username}`);
    const result = await loginAndDownload(account);
    if (!result) {
      console.log(`账户 ${account.username} 登录失败，跳过该账户`);
    }
  }
}

module.exports = { loginAndDownload, signInMultipleAccounts };