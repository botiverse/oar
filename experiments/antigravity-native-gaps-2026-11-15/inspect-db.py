"""Decode field numbers, not a guessed AGY schema, from synthetic experiment rows."""
import base64
import json
import pathlib
import sys

def decode(data,depth=0):
 if depth>15:return None
 pos=0;result=[]
 def varint():
  nonlocal pos
  value=0
  for shift in range(0,70,7):
   if pos>=len(data):raise ValueError('short varint')
   b=data[pos];pos+=1;value|=(b&127)<<shift
   if b<128:return value
  raise ValueError('long varint')
 try:
  while pos<len(data):
   tag=varint();field=tag>>3;wire=tag&7
   if not field:raise ValueError('field zero')
   if wire==0:value=varint()
   elif wire in (1,5):
    length=8 if wire==1 else 4;value={'hex':data[pos:pos+length].hex()};pos+=length
   elif wire==2:
    length=varint()
    if pos+length>len(data):raise ValueError('short message')
    part=data[pos:pos+length];pos+=length
    try:
     txt=part.decode('utf8')
     if any(ord(ch)<32 and ch not in '\n\t\r' for ch in txt):raise ValueError('control')
     value=txt
    except (UnicodeDecodeError,ValueError):
     value=decode(part,depth+1)
     if value is None:value={'base64':base64.b64encode(part).decode()}
   else:raise ValueError('wire type')
   result.append({'field':field,'wire':wire,'value':value})
  return result
 except ValueError:return None

def strings(value,prefix=''):
 if not isinstance(value,list):return
 for entry in value:
  key=prefix+'.'+str(entry['field'])
  if isinstance(entry['value'],str):yield key,entry['value']
  elif isinstance(entry['value'],list):yield from strings(entry['value'],key)


def field(value, number):
    return next((entry["value"] for entry in value or [] if entry["field"] == number), None)


def inspect(probe_file):
    probe = json.loads(probe_file.read_text())
    raw = [json.loads(line) for line in pathlib.Path(str(probe_file) + ".db.ndjson").read_text().splitlines()]
    end = next((tick["atMs"] for tick in probe["ticks"] if tick["kind"] == "record" and tick["body"].get("body", {}).get("type") == "session/prompt"), None)
    selected = []
    for row in raw:
        if row.get("table") != "steps" or row["kind"] != "row":
            continue
        values = row["values"]
        payload = decode(base64.b64decode(values["step_payload"]["base64"]))
        metadata = decode(base64.b64decode(values["metadata"]["base64"]))
        timestamp = field(metadata, 1)
        native_time = None
        if isinstance(timestamp, list) and isinstance(field(timestamp, 1), int):
            native_time = field(timestamp, 1) * 1000 + (field(timestamp, 2) or 0) / 1_000_000
        at_ms = row["observedEpochMs"] - probe["startedEpochMs"]
        selected.append({
            "file": row["file"], "observedMs": at_ms,
            "observedRelativeToEndMs": None if end is None else at_ms - end,
            "idx": values["idx"], "step_type": values["step_type"], "status": values["status"],
            "step_format": values["step_format"], "error_details": values["error_details"],
            "metadataField1EpochMs": native_time,
            "metadataField1RelativeToEndMs": None if native_time is None or end is None else native_time - probe["startedEpochMs"] - end,
            "payload": payload,
        })
    return {"mode": probe["mode"], "endTurnMs": end, "result": probe["result"],
            "schemas": [row for row in raw if row["kind"] == "schema"], "steps": selected}

if __name__ == "__main__":
    print(json.dumps(inspect(pathlib.Path(sys.argv[1])), indent=2))
