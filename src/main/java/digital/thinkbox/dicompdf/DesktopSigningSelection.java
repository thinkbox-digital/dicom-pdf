package digital.thinkbox.dicompdf;

import com.google.gson.*;
import java.nio.file.*;
import java.util.*;

/** One desktop signing source: a certificate or a policy containing its identity. */
record DesktopSigningSelection(String certificate,String configuration,String protection,String tsaUrl,String passphraseFile) {
    static DesktopSigningSelection read(String value)throws Exception{
        if(value==null||value.isBlank())return new DesktopSigningSelection("","",null,null,"");
        Path path=Path.of(value.strip()).toAbsolutePath().normalize();
        if(!Files.isRegularFile(path))throw new IllegalArgumentException("Choose an existing .p12, .pfx or signing configuration .json file.");
        String name=path.getFileName().toString().toLowerCase(Locale.ROOT);
        if(name.endsWith(".p12")||name.endsWith(".pfx"))return new DesktopSigningSelection(path.toString(),"","CMS_AND_PDF",null,"");
        if(!name.endsWith(".json"))throw new IllegalArgumentException("Signing identity must be a .p12, .pfx or configuration .json file.");
        if(Files.size(path)>1024*1024)throw new IllegalArgumentException("Signing configuration exceeds 1 MiB.");
        JsonObject json;
        try{json=JsonParser.parseString(Files.readString(path)).getAsJsonObject();}
        catch(RuntimeException error){throw new IllegalArgumentException("Signing configuration must be a JSON object.");}
        String protection=required(json,"protection");
        if(!Set.of("CMS_AND_PDF","CMS_AND_PDF_TIMESTAMPED","PADES_B_LTA").contains(protection))throw new IllegalArgumentException("Unsupported signing protection: "+protection);
        Path certificate=path.toRealPath().getParent().resolve(required(json,"pkcs12")).normalize();
        String tsa=json.has("tsaUrl")?required(json,"tsaUrl"):null;
        if(tsa!=null){
            var uri=java.net.URI.create(tsa);
            if(!Set.of("http","https").contains(uri.getScheme()==null?"":uri.getScheme().toLowerCase(Locale.ROOT))||uri.getHost()==null||uri.getUserInfo()!=null||uri.getQuery()!=null||uri.getFragment()!=null)
                throw new IllegalArgumentException("Timestamp service must be an HTTP or HTTPS URL without credentials, query or fragment.");
        }
        String passphrase=json.has("passphraseFile")?path.toRealPath().getParent().resolve(required(json,"passphraseFile")).normalize().toString():"";
        return new DesktopSigningSelection(certificate.toString(),path.toString(),protection,tsa,passphrase);
    }
    boolean timestampRequired(){return protection!=null&&!protection.equals("CMS_AND_PDF");}
    void requireTimestampSettings(){
        if(configuration.isBlank())throw new IllegalArgumentException("Timestamping is on. Select a signing JSON containing pkcs12, passphraseFile, tsaUrl and trusted TSA certificates.");
        if(tsaUrl==null)throw new IllegalArgumentException("Timestamping is on, but the selected JSON has no tsaUrl. Add an HTTP or HTTPS timestamp service URL and its trusted certificates.");
    }
    String description(boolean timestamping){
        if(protection==null)return timestamping?"Timestamping is on. Select a signing JSON with a certificate, timestamp service and TSA trust settings.":"No export certificate selected. C2PA uses an unverified local identity when enabled.";
        String mode=protection.equals("PADES_B_LTA")?"PAdES B-LTA":timestamping||timestampRequired()?"Manifest and PDF signatures with timestamps":"Manifest and PDF signatures";
        return mode+". "+(configuration.isBlank()?"Password requested on Create.":"Certificate: "+certificate+".")
            +(timestamping?configuration.isBlank()?"\nTimestamping is on. Select a JSON to configure the timestamp service and TSA trust.":tsaUrl==null?"\nTimestamping is on. Add tsaUrl and TSA trust settings to this JSON.":"\nTimestamping is on: "+tsaUrl+". Creation stops if timestamps cannot be verified.":timestampRequired()?"\nThis policy requires timestamps. Check Add trusted timestamps to create the archive.":"\nTrusted timestamps are off. Check Add trusted timestamps to enable them.");
    }
    private static String required(JsonObject json,String name){
        if(!json.has(name)||!json.get(name).isJsonPrimitive()||!json.get(name).getAsJsonPrimitive().isString()||json.get(name).getAsString().isBlank())
            throw new IllegalArgumentException("Signing configuration requires "+name+".");
        return json.get(name).getAsString();
    }
}
