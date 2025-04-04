const fs = require('fs');
const { loginAndDownload } = require('./apps/loginAndDownload');

async function testAllAccounts() {
  // 添加北京时间日志
  const options = {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  };
  
  const beijingTime = new Date().toLocaleString('zh-CN', options);
  console.log(`======================================`);
  console.log(`程序启动时间(北京时间): ${beijingTime}`);
  console.log(`======================================`);

  const accounts = JSON.parse(fs.readFileSync('./config/accounts.json', 'utf8'));

  for (let account of accounts) {
    const loginSuccess = await loginAndDownload(account);
    if (!loginSuccess) {
      console.log(`账户 ${account.username} 退出`);
    }
  }
  
  // 程序结束时间(北京时间)
  const endTime = new Date().toLocaleString('zh-CN', options);
  console.log(`======================================`);
  console.log(`程序结束时间(北京时间): ${endTime}`);
  console.log(`======================================`);
}

testAllAccounts();
