package digital.thinkbox.dicompdf;

import com.google.gson.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;

/** Hash-bound observation of an import container, not an acquisition/authenticity claim. */
final class ImportProvenance {
    private ImportProvenance(){}
    static void writeZip(Path archive,String name,int members,Path destination)throws Exception{
        var digest=MessageDigest.getInstance("SHA-256");byte[] block=new byte[64*1024];
        try(var input=Files.newInputStream(archive)){int count;while((count=input.read(block))!=-1)digest.update(block,0,count);}
        var value=new JsonObject();value.addProperty("schemaVersion",1);value.addProperty("kind","ZIP_IMPORT");value.addProperty("basis","LOCAL_CONTAINER_EXTRACTION");
        value.addProperty("sourceName",name);value.addProperty("sourceBytes",Files.size(archive));value.addProperty("sourceSha256",HexFormat.of().formatHex(digest.digest()));
        value.addProperty("containerEmbedded",false);value.addProperty("memberRoot","contents/");value.addProperty("memberCount",members);
        Files.write(destination,ManifestEncoding.canonicalize(value.toString()),StandardOpenOption.CREATE_NEW);
    }
    static byte[] read(Path path)throws Exception{
        if(!Files.isRegularFile(path)||Files.size(path)>64*1024)throw new IOException("Import receipt exceeds its supported size.");
        byte[] data;try(var input=Files.newInputStream(path)){data=input.readNBytes(64*1024+1);}
        if(data.length>64*1024)throw new IOException("Import receipt exceeds its supported size.");
        return validate(data);
    }
    static byte[] validate(byte[] bytes)throws Exception{
        String decoded=StandardCharsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes)).toString();
        var json=JsonParser.parseString(decoded).getAsJsonObject();
        for(String key:List.of("schemaVersion","sourceBytes","memberCount"))if(!json.has(key)||!json.get(key).isJsonPrimitive()||!json.getAsJsonPrimitive(key).isNumber())throw new IOException("Invalid import receipt numeric field.");
        if(!json.has("containerEmbedded")||!json.get("containerEmbedded").isJsonPrimitive()||!json.getAsJsonPrimitive("containerEmbedded").isBoolean())throw new IOException("Invalid import receipt container flag.");
        long version=json.get("schemaVersion").getAsBigDecimal().longValueExact(),size=json.get("sourceBytes").getAsBigDecimal().longValueExact(),count=json.get("memberCount").getAsBigDecimal().longValueExact();
        if(!json.keySet().equals(Set.of("schemaVersion","kind","basis","sourceName","sourceBytes","sourceSha256","containerEmbedded","memberRoot","memberCount"))
            ||version!=1||!"ZIP_IMPORT".equals(json.get("kind").getAsString())||!"LOCAL_CONTAINER_EXTRACTION".equals(json.get("basis").getAsString())
            ||json.get("containerEmbedded").getAsBoolean()||!"contents/".equals(json.get("memberRoot").getAsString())
            ||size<0||!json.get("sourceSha256").getAsString().matches("[0-9a-f]{64}")
            ||count<1||count>InputFiles.MAX_FILES)throw new IOException("Invalid ZIP import receipt.");
        String name=json.get("sourceName").getAsString();if(name.isBlank()||name.contains("/")||name.contains("\\"))throw new IOException("Invalid ZIP import receipt name.");
        return ManifestEncoding.canonicalize(json.toString());
    }
}
