"""Linux native cold-skill probe; usage: python3 probe.py /absolute/path/to/opencode."""
import base64,json,os,pathlib,queue,secrets,signal,subprocess,sys,tempfile,threading,time,urllib.request
root=pathlib.Path(tempfile.mkdtemp(prefix='oar-skill-v2-ready-'))
home=root/'home';project=root/'project';config=root/'config'
for p in [home,project,config]: p.mkdir()
subprocess.run(['git','init','-q',str(project)],check=True)
fixtures={'home-claude':home/'.claude/skills','home-agents':home/'.agents/skills','project-claude':project/'.claude/skills','project-agents':project/'.agents/skills','project-opencode':project/'.opencode/skills','config-opencode':config/'opencode/skills'}
for name,path in fixtures.items():
 f=path/name/'SKILL.md';f.parent.mkdir(parents=True);f.write_text(f'---\nname: {name}\ndescription: Synthetic native inventory fixture {name}\n---\nSynthetic body.\n')
env={'PATH':os.environ['PATH'],'HOME':str(home),'USERPROFILE':str(home),'XDG_CONFIG_HOME':str(config),'XDG_DATA_HOME':str(root/'data'),'XDG_CACHE_HOME':str(root/'cache'),'XDG_STATE_HOME':str(root/'state'),'OPENCODE_DISABLE_AUTOUPDATE':'true','OPENCODE_DISABLE_MODELS_FETCH':'true','NO_COLOR':'1','OPENCODE_SERVER_PASSWORD':secrets.token_hex(32)}
binary=str(pathlib.Path(sys.argv[1]).resolve())
start=time.monotonic(); err=(root/'stderr.log').open('w');p=subprocess.Popen([binary,'serve','--stdio','--hostname','127.0.0.1','--port','0'],cwd=project,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=err,text=True,start_new_session=True)
results=[]
try:
 lines=queue.Queue()
 threading.Thread(target=lambda: lines.put(p.stdout.readline()),daemon=True).start()
 line=lines.get(timeout=30);url=json.loads(line)['url']
 def query(path):
  request=urllib.request.Request(url+path,headers={'Authorization':'Basic '+base64.b64encode(('opencode:'+env['OPENCODE_SERVER_PASSWORD']).encode()).decode(),'x-opencode-directory':str(project)})
  with urllib.request.urlopen(request,timeout=12) as r: return json.load(r)
 for path in ['/api/skill','/api/provider','/api/skill','/api/plugin']:
  try:
   result=query(path)
   results.append({'path':path,'elapsed':time.monotonic()-start,'result':result})
  except Exception as e:results.append({'path':path,'error':str(e)})
finally:
 p.stdin.close()
 try:p.wait(timeout=5)
 except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
 err.close()
selected=[]
for result in results:
 data=result.get('result',{}).get('data',[])
 row={'path':result['path'],'elapsed':result.get('elapsed')}
 if 'error' in result: row['error']='Native request failed'
 elif result['path']=='/api/skill':
  row['skills']=[{k:x[k] for k in ['id','name','path','autoinvoke'] if k in x} for x in data]
 else:
  row['count']=len(data)
  if result['path']=='/api/plugin': row['states']=[x.get('state',{}).get('status') for x in data]
 selected.append(row)
print(json.dumps({'queries':selected,'processExit':p.returncode},indent=2).replace(str(root),'<fixture>'))
