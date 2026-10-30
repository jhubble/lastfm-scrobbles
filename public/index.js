<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Last.fm Scrobble Dashboard</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #121214; color: #e1e1e6; margin: 0; padding: 20px; }
    .container { max-width: 1000px; margin: 0 auto; }
    h1 { color: #e5151f; margin-bottom: 20px; }
    .card { background: #202024; padding: 20px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
    .controls { display: flex; gap: 10px; margin-bottom: 20px; }
    input { background: #121214; border: 1px solid #323238; color: #fff; padding: 10px; border-radius: 4px; flex: 1; }
    button { background: #e5151f; border: none; color: white; padding: 10px 16px; border-radius: 4px; cursor: pointer; font-weight: bold; }
    button:hover { background: #b81018; }
    button:disabled { background: #555; cursor: not-allowed; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; }
    .stat-box { background: #29292e; padding: 15px; border-radius: 6px; text-align: center; }
    .stat-val { font-size: 24px; font-weight: bold; color: #fff; margin-top: 5px; }
    .status { margin-top: 10px; font-style: italic; color: #a8a8b3; }
    ul { list-style: none; padding: 0; max-height: 300px; overflow-y: auto; }
    li { border-bottom: 1px solid #323238; padding: 8px 0; display: flex; justify-content: space-between; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎵 Last.fm Scrobble Dashboard</h1>
    
    <div class="card">
      <div class="controls">
        <input type="text" id="username" placeholder="Enter Last.fm Username">
        <button id="btnFetch" onclick="fetchLocalData()">Load Scrobbles</button>
        <button id="btnDownload" onclick="downloadAll()">Download All</button>
        <button id="btnSync" onclick="syncNewer()">Fetch Newer</button>
      </div>
      <div id="status" class="status"></div>
    </div>

    <div class="grid" id="statsGrid">
      <div class="stat-box">Total Scrobbles<div class="stat-val" id="stTotal">-</div></div>
      <div class="stat-box">First Scrobble<div class="stat-val" style="font-size: 14px;" id="stFirst">-</div></div>
      <div class="stat-box">Last Scrobble<div class="stat-val" style="font-size: 14px;" id="stLast">-</div></div>
      <div class="stat-box">Scrobbles / Month<div class="stat-val" id="stRate">-</div></div>
    </div>

    <div class="card" style="margin-top: 20px;">
      <h2>Recent Scrobbles</h2>
      <ul id="scrobbleList"></ul>
    </div>
  </div>

  <script src="app.js"></script>
</body>
</html>
